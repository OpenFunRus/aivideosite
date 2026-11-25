(() => {
  "use strict";
  const api = window.AIVideoV2;
  if (!api) return;
  const { state, qs, copyText, showToast } = api;

  const selected = (items, ids) => {
    const byId = new Map((items || []).map((item) => [String(item.id), item]));
    return Array.from(ids || []).map((id) => byId.get(String(id))).filter(Boolean);
  };

  const field = (label, value) => {
    const lines = String(value || "").trim().replace(/\r\n?/g, "\n").split("\n");
    if (!lines[0]) return `  ${label}: не указано`;
    return `  ${label}: ${lines[0]}` + lines.slice(1).map((line) => `\n    ${line}`).join("");
  };

  const referenceLines = (item) => {
    const count = Math.max(0, Number(item.image_count) || 0);
    const names = Array.isArray(item.image_names) ? item.image_names : [];
    if (!count) return ["  Референсы: нет изображений"];
    return [
      `  Референсы изображений (${count}):`,
      ...Array.from({ length: count }, (_, index) =>
        `    ${index + 1}. ${names[index] || "исходное имя файла не сохранилось"}`
      ),
    ];
  };

  const characterLines = (character, index) => {
    const muted = !character.voice || state.mutedCharacterIds.has(String(character.id));
    const preset = String(character.voice_preset_name || character.voice_preset_id || "").trim();
    const voice = !character.voice
      ? "не выбран"
      : preset
        ? `Встроенный голос «${preset}»`
        : character.voice_name
          ? `Свой голос — ${character.voice_name}`
          : "Свой голос (имя файла не сохранилось)";
    return [
      `${index + 1}. Персонаж: ${character.name}`,
      field("Описание / промпт", character.description),
      ...referenceLines(character),
      `  Выбранный голос: ${voice}${muted && character.voice ? " (отключён)" : ""}`,
      `  Речь: ${muted ? "speech_policy: silent (персонаж молчит)" : "только явно указанные реплики"}`,
    ].join("\n");
  };

  const locationLines = (location, index) => [
    `${index + 1}. Локация: ${location.name}`,
    field("Описание / промпт", location.prompt),
    ...referenceLines(location),
  ].join("\n");

  const miscLines = (item, index) => [
    `${index + 1}. Пресет: ${item.name}`,
    field("Категория", item.category_label || item.category),
    field("Описание / промпт", item.description),
    ...referenceLines(item),
  ].join("\n");

  const section = (title, items, render) =>
    `${title} (${items.length})\n` + (items.length
      ? items.map(render).join("\n\n")
      : "Не выбраны.");

  const buildPresetExport = () => {
    const characters = selected(state.characters, state.selectedCharacterIds);
    const locations = selected(state.locations, state.selectedLocationIds);
    const misc = selected(state.misc, state.selectedMiscIds);
    if (!characters.length && !locations.length && !misc.length) return "";

    return [
      "КОНТЕКСТ ВИДЕОСЦЕНЫ — ВЫБРАННЫЕ ПРЕСЕТЫ",
      "Используй эти описания при подготовке промпта для видео, раскадровки или изображения сцены. Сохраняй имена и отличительные детали персонажей, локаций и предметов. Не заставляй молчащих персонажей говорить.",
      "Это текстовый список референсов; сами изображения и аудиофайлы сюда не копируются. Если важна точная внешность, запроси изображения отдельно.",
      "",
      section("ПЕРСОНАЖИ", characters, characterLines),
      "",
      section("ЛОКАЦИИ", locations, locationLines),
      "",
      section("ПРОПСЫ И ПРОЧИЕ ПРЕСЕТЫ", misc, miscLines),
    ].join("\n");
  };

  qs("#v2-preset-copy")?.addEventListener("click", async () => {
    const text = buildPresetExport();
    if (!text) {
      showToast("Сначала выберите персонажа, локацию или пропс.", "error");
      return;
    }
    try {
      await copyText(text);
      showToast("Выбранные пресеты скопированы для ChatGPT.");
    } catch {
      showToast("Не удалось скопировать текст. Проверьте разрешения браузера.", "error");
    }
  });

  api.buildPresetExport = buildPresetExport;
})();
