(() => {
  "use strict";
  const api = window.AIVideoV2;
  const W = window.AIVideoV2Workspaces;
  if (!api || !W) return;
  const { qs, fetchJson, showToast } = api;

  const currentAudioAssistantSettings = () => ({
    workspace: "audio",
    prompt: String(qs("#v2-audio-prompt")?.value || ""),
    generation_mode: "digital_human",
    reference_task: "audio_reference",
    quality: W.settingValue("audio-quality", "720"),
    resolution_shape: W.settingValue("audio-ratio", "16:9"),
    seconds: Number(W.settingValue("audio-seconds", "10")),
    fps: 24,
    steps: Number(W.settingValue("audio-steps", "12")),
    seed: Number(qs("#v2-audio-seed")?.value || -1),
    embed_track: Boolean(qs("#v2-audio-embed-track")?.checked),
    generate_scene_audio: Boolean(qs("#v2-audio-scene-sound")?.checked),
    generate_audio: Boolean(qs("#v2-audio-scene-sound")?.checked),
    selected_character_ids: W.selectedCharacterIds(),
    selected_location_ids: W.selectedLocationIds(),
    selected_misc_ids: W.selectedMiscIds(),
    muted_character_ids: W.mutedCharacterIds(),
    track_id: String(qs("#v2-audio-track")?.value || ""),
    visual_reference_name: String(qs("#v2-audio-visual")?.files?.[0]?.name || ""),
    ...(W.audioAssistantContext?.() || {}),
  });

  api.currentAudioAssistantSettings = currentAudioAssistantSettings;

  const improveAudioPrompt = async () => {
    const target = qs("#v2-audio-prompt");
    const source = target?.value.trim();
    if (!source) {
      showToast("Сначала напишите обычный prompt.", "error");
      target?.focus();
      return;
    }

    const button = qs('[data-v2-wand="audio"]');
    if (button) button.disabled = true;
    try {
      const instruction =
        "Перепиши запрос для V2 «По аудио» в канонические три H3-поля. " +
        "Это Digital Human: master track уже является driving audio, поэтому НЕ описывай его как музыку, которую H3 должен сочинить, и ставь non_diegetic_music: N/A. " +
        "Синхронизируй видимое исполнение, артикуляцию, жесты и body motion с driving audio, но не выдумывай lyrics, если пользователь их не дал. " +
        "Если «Фоновые звуки H3» выключены — overall_soundscape: N/A; если включены — только физические/фоновые звуки сцены, без дублирования master track. " +
        "Backend сам добавит реальные reference labels. Тайминг shots обязан укладываться в выбранную duration. Return only changes.prompt.";

      const result = await fetchJson("/api/assistant/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: instruction + "\n\n" + source }],
          settings: currentAudioAssistantSettings(),
          thinking: false,
        }),
      });
      const improved = result?.changes?.prompt;
      if (!improved) throw new Error(result?.message || "ИИ не вернул prompt.");
      target.value = String(improved).trim();
      target.dispatchEvent(new Event("input", { bubbles: true }));
      showToast("Prompt улучшен под H3.");
    } catch (error) {
      showToast("Не удалось улучшить prompt: " + error.message, "error");
    } finally {
      if (button) button.disabled = false;
    }
  };

  qs('[data-v2-wand="audio"]')?.addEventListener("click", improveAudioPrompt);
})();