(() => {
  "use strict";
  const api = window.AIVideoV2;
  if (!api) return;
  const { state, qs, qsa, fetchJson, showToast, saveDraft } = api;

  const prompt = qs("#v2-prompt");
  const promptCount = qs("#v2-prompt-count");
  const seed = qs("#v2-seed");
  const audio = qs("#v2-audio");
  const promptClear = qs("#v2-prompt-clear");

  const resolvedVideoSize = () => {
    const shortSide = ({ "480": 480, "720": 736, "1080": 1088 })[String(state.draft.quality)] || 736;
    const ratio = ({ "1:1": [1, 1], "16:9": [16, 9], "9:16": [9, 16] })[String(state.draft.ratio)] || [16, 9];
    const gridUp = (value) => Math.ceil(value / 32) * 32;
    if (ratio[0] === ratio[1]) return shortSide + "x" + shortSide;
    if (ratio[0] > ratio[1]) return gridUp(shortSide * ratio[0] / ratio[1]) + "x" + shortSide;
    return shortSide + "x" + gridUp(shortSide * ratio[1] / ratio[0]);
  };

  const applySegment = (setting, value, save = true) => {
    const group = qs('[data-setting="' + setting + '"]');
    if (!group) return;
    const buttons = qsa("[data-value]", group);
    const target = buttons.find((button) => button.dataset.value === String(value)) || buttons[0];
    buttons.forEach((button) => button.classList.toggle("active", button === target));
    if (target) state.draft[setting] = target.dataset.value;
    if (setting === "seconds") window.AIVideoV2Workspaces?.updateAudioRange?.();
    if (save) saveDraft();
  };

  qsa("[data-setting]").forEach((group) => {
    group.addEventListener("click", (event) => {
      const button = event.target.closest("[data-value]");
      if (!button) return;
      applySegment(group.dataset.setting, button.dataset.value);
    });
  });

  const updatePromptCount = () => {
    if (promptCount && prompt) {
      promptCount.textContent = prompt.value.length.toLocaleString("ru-RU") + " / 16 000";
    }
    if (promptClear) promptClear.disabled = !prompt?.value;
  };

  prompt?.addEventListener("input", () => {
    state.draft.prompt = prompt.value;
    updatePromptCount();
    saveDraft();
  });
  promptClear?.addEventListener("click", () => {
    if (!prompt) return;
    prompt.value = "";
    state.draft.prompt = "";
    updatePromptCount();
    saveDraft();
    prompt.focus();
  });
  seed?.addEventListener("input", () => {
    state.draft.seed = seed.value;
    saveDraft();
  });
  audio?.addEventListener("change", () => {
    state.draft.audio = audio.checked;
    saveDraft();
  });

  const setupUploadCard = (kind) => {
    const card = qs('[data-v2-upload="' + kind + '"]');
    const input = card?.querySelector('input[type="file"]');
    const preview = card?.querySelector(".v2-upload-preview");
    const placeholder = card?.querySelector(".v2-upload-placeholder");
    const remove = card?.querySelector(".v2-upload-remove");
    if (!card || !input || !preview || !placeholder || !remove) return;

    const render = () => {
      const file = input.files?.[0];
      const oldUrl = state.uploadUrls.get(kind);
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      state.uploadUrls.delete(kind);

      if (!file) {
        preview.hidden = true;
        preview.removeAttribute("src");
        placeholder.hidden = false;
        remove.hidden = true;
        api.updateCreateCompatibility?.();
        return;
      }

      const url = URL.createObjectURL(file);
      state.uploadUrls.set(kind, url);
      preview.src = url;
      preview.hidden = false;
      placeholder.hidden = true;
      remove.hidden = false;
      api.updateCreateCompatibility?.();
    };

    input.addEventListener("change", render);
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      input.value = "";
      render();
    });

    ["dragenter", "dragover"].forEach((name) => {
      card.addEventListener(name, (event) => {
        event.preventDefault();
        card.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach((name) => {
      card.addEventListener(name, () => card.classList.remove("dragover"));
    });
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      const files = event.dataTransfer?.files;
      if (!files?.length) return;
      const transfer = new DataTransfer();
      transfer.items.add(files[0]);
      input.files = transfer.files;
      render();
    });
  };

  setupUploadCard("first");
  setupUploadCard("last");

  qs("#v2-wand")?.addEventListener("click", async () => {
    const source = prompt?.value.trim() || "";
    if (!source) {
      showToast("Сначала напишите обычный промт.", "error");
      prompt?.focus();
      return;
    }
    const button = qs("#v2-wand");
    const audioMode = Boolean(window.AIVideoV2Workspaces?.audioModeEnabled?.());
    const audioContext = window.AIVideoV2Workspaces?.audioAssistantContext?.() || {};
    const hasPresets =
      state.selectedCharacterIds.size > 0 ||
      state.selectedLocationIds.size > 0 ||
      state.selectedMiscIds.size > 0;
    const hasFrames = Boolean(
      qs("#v2-first-frame")?.files?.[0] ||
      qs("#v2-last-frame")?.files?.[0]
    );
    const audioDrivesH3 = audioMode && (hasPresets || hasFrames);
    button.disabled = true;
    showToast(audioMode ? "Локальный ИИ улучшает промт под аудиодорожку…" : "Локальный ИИ улучшает промт…");
    try {
      const modeInstruction = audioMode
        ? (
          audioDrivesH3
            ? (
              "Это режим Digital Human с driving audio внутри единой страницы «Видео»: visual reference берётся из выбранных Characters/Locations/Misc либо из First/Last кадра. " +
              "Если semantic preset не выбран, backend повторно использует первый доступный endpoint-кадр как visual anchor и отдельно закрепляет First/Last точными Timeline Guides. " +
              "Master track передаётся модели как управляющее аудио: синхронизируй видимую артикуляцию, пение, жесты и body motion с ним, но не проси H3 сочинять или повторять этот трек. " +
              "Если исходный запрос — Song/Sing/песня/поёт/петь, это явное требование: видимый субъект должен петь с lip-sync под driving vocals, а не просто стоять или идти. " +
              "non_diegetic_music: N/A. Если generate_scene_audio выключен — overall_soundscape: N/A; если включен — только физические/фоновые звуки сцены. " +
              "First/Last при наличии backend закрепляет отдельно как exact native MiniMaxH3AddGuide anchors, поэтому не придумывай для них Picture labels и не добавляй FL2VA alignment line. "
            )
            : (
              "Это обычный Video/FL2VA режим с выбранным master track для итогового MP4, НЕ Digital Human. " +
              "Master track не передаётся H3 как driving audio, поэтому не требуй visual reference и не описывай синхронизацию артикуляции с треком. " +
              "Разрешены prompt-only, First, Last и First→Last; First/Last здесь являются обычными FL2VA endpoint-кадрами. " +
              "non_diegetic_music: N/A. Если generate_scene_audio выключен — overall_soundscape: N/A; если включен — только физические/фоновые звуки сцены. "
            )
        )
        : (
          "Это обычный режим Video без driving master track. " +
          "Если First/Last используются без Characters/Locations/Misc — добавь правильную FL2VA alignment line из H3 guide. " +
          "Если First/Last используются вместе с Characters/Locations/Misc — НЕ добавляй Picture alignment line: backend применит кадры отдельно как exact Timeline Guides. "
        );
      const result = await fetchJson("/api/assistant/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{
            role: "user",
            content:
              "Перепиши только этот запрос для поля prompt раздела «Видео». " +
              modeInstruction +
              "Верни только финальный H3 prompt в каноническом формате из трёх полей: " +
              "integrated_multimodal_description, overall_soundscape, non_diegetic_music. " +
              "Соблюдай выбранную длительность: [Shot 1] без времени, каждый следующий cut с точным временем. " +
              "Один основной camera move на shot. Точные реплики оформляй как (S1) и <d>[Language] ...</d> без перевода. " +
              "Если generate_audio выключен — overall_soundscape: N/A и non_diegetic_music: N/A. " +
              "Если звук включён, но музыки не просили — non_diegetic_music: N/A. " +
              "Если выбраны Characters, Locations или Misc, не придумывай Picture/Subject ordinals и не пиши шесть Ref2VA-полей: backend добавит реальные semantic references сам. " +
              "Selected Misc presets — реальные H3 semantic references предметов, одежды, оружия, транспорта, существ, особенностей, поз/действий, стилей и прочего; обязательно учитывай их name/category/description в сцене, не выдумывая новые свойства. " +
              "Сохрани все конкретные факты буквально: если написано 35 лет — в результате тоже должно быть 35, а не диапазон возраста. " +
              "Точную реплику пиши один раз: только как (S1) <d>[Russian] ...</d>, не дублируй её обычными кавычками перед тегом. " +
              "Не придумывай гром, шаги, ветер, транспорт, новые действия или другие детали, которых нет в запросе. " +
              "Не меняй настройки формы и не добавляй события, которых пользователь не просил. " +
              "Не пиши JSON, changes.prompt, message, Mode/Duration/FPS/Steps или другие служебные строки. Верни только три поля H3.\n\n" +
              source,
          }],
          settings: {
            ...(api.currentAssistantSettings?.() || {}),
            ...audioContext,
            workspace: "create",
            quality: String(state.draft.quality || "720"),
            resolution_shape: String(state.draft.ratio || "16:9"),
            resolution: resolvedVideoSize(),
            seconds: Number(state.draft.seconds || 10),
            fps: 24,
            steps: Number(state.draft.steps || 12),
            seed: String(state.draft.seed || "").trim() ? Number(state.draft.seed) : -1,
            audio_mode: audioMode,
            has_driving_audio: audioDrivesH3,
            generation_mode: audioDrivesH3
              ? "digital_human"
              : (hasFrames ? (hasPresets ? "multiframe" : "frames") : (hasPresets ? "reference" : "frames")),
            reference_task: audioDrivesH3
              ? "audio_reference"
              : (hasFrames && hasPresets ? "timeline_guides" : "reference_generation"),
            generate_audio: audioMode ? Boolean(audioContext.generate_scene_audio) : Boolean(qs("#v2-audio")?.checked),
            has_first_frame: Boolean(qs("#v2-first-frame")?.files?.[0]),
            has_last_frame: Boolean(qs("#v2-last-frame")?.files?.[0]),
            endpoint_mode:
              qs("#v2-first-frame")?.files?.[0] && qs("#v2-last-frame")?.files?.[0]
                ? "first_last"
                : qs("#v2-first-frame")?.files?.[0]
                  ? "first"
                  : qs("#v2-last-frame")?.files?.[0]
                    ? "last"
                    : "none",
          },
          thinking: false,
        }),
      });
      const improved = result?.changes?.prompt;
      if (typeof improved !== "string" || !improved.trim()) {
        throw new Error(result?.message || "ИИ не вернул улучшенный промт.");
      }
      prompt.value = improved.trim();
      state.draft.prompt = prompt.value;
      updatePromptCount();
      saveDraft();
      showToast("Промт улучшен под MiniMax H3.");
    } catch (error) {
      showToast("Не удалось улучшить промт: " + error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  const createForm = qs("#v2-create-form");
  const generateButton = qs("#v2-generate");
  const generateLabel = qs(".v2-generate-label", generateButton || document);
  const createWarning = qs("#v2-create-warning");
  const firstFrameInput = qs("#v2-first-frame");
  const lastFrameInput = qs("#v2-last-frame");
  const gpuDialog = qs("#v2-gpu-dialog");
  const gpuDialogClose = qs("[data-v2-gpu-close]", gpuDialog || document);
  const gpuButtons = Array.from(gpuDialog?.querySelectorAll("[data-v2-gpu-target]") || []);
  let gpuPollTimer = null, gpuSubmitting = false;
  const createHasFrames=()=>Boolean(firstFrameInput?.files?.length||lastFrameInput?.files?.length);
  const updateCreateCompatibility=()=>{
    const hasPresets=state.selectedCharacterIds.size>0||state.selectedLocationIds.size>0||state.selectedMiscIds.size>0;
    const mixed=hasPresets&&createHasFrames();
    if(createWarning){createWarning.hidden=!mixed;createWarning.textContent=mixed?"Персонажи, локации и «Прочее» задают semantic references, а First/Last используются как точные Timeline Guides. Их можно применять вместе.":"";}
    if(generateButton&&!generateButton.classList.contains("is-loading"))generateButton.disabled=false;
    return true;
  };
  const gpuStateNode=(b)=>b?.querySelector("[data-v2-gpu-state]");
  const setGpuButton=(b,s)=>{if(!b)return;const n=gpuStateNode(b),ok=Boolean(s?.available)&&!gpuSubmitting;b.disabled=!ok;b.classList.toggle("available",ok);b.classList.toggle("busy",!ok);if(n)n.textContent=s?String(s.busy_label||(s.available?"Свободна":"Занята")):"Нет данных";};
  const renderGpuSlots=(slots)=>{const m=new Map((Array.isArray(slots)?slots:[]).map(s=>[String(s.target||""),s]));gpuButtons.forEach(b=>setGpuButton(b,m.get(String(b.dataset.v2GpuTarget||""))));};
  const refreshGpuSlots=async()=>{if(!gpuDialog?.open)return;try{const d=await fetchJson("/api/v2/gpu-slots");renderGpuSlots(d?.slots||[]);}catch{renderGpuSlots([]);}};
  const stopGpuPolling=()=>{if(gpuPollTimer)clearInterval(gpuPollTimer);gpuPollTimer=null;};
  const closeGpuDialog=()=>{stopGpuPolling();if(gpuDialog?.open)gpuDialog.close();};
  const openGpuDialog=async()=>{if(!gpuDialog){showToast("Окно выбора GPU недоступно.","error");return;}gpuSubmitting=false;renderGpuSlots([]);gpuDialog.showModal();await refreshGpuSlots();stopGpuPolling();gpuPollTimer=setInterval(refreshGpuSlots,1000);};
  const validateCreateRequest=()=>{
    updateCreateCompatibility();const sourcePrompt=prompt?.value.trim()||"";if(!sourcePrompt){showToast("Сначала напишите prompt.","error");prompt?.focus();return null;}
    const audioSubmission=window.AIVideoV2Workspaces?.audioSubmission?.()||{enabled:false};
    if(audioSubmission.enabled&&(!audioSubmission.hasTrack||(!audioSubmission.uploadedAudio&&!audioSubmission.trackId))){showToast("Выберите аудиодорожку.","error");return null;}
    return {sourcePrompt,audioSubmission};
  };
  const submitCreate=async(gpuTarget,req,sourceButton)=>{
    if(gpuSubmitting)return;gpuSubmitting=true;gpuButtons.forEach(b=>b.disabled=true);const sn=gpuStateNode(sourceButton);if(sn)sn.textContent="Резервируем GPU…";
    const {sourcePrompt,audioSubmission}=req,formData=new FormData();
    formData.set("prompt",sourcePrompt);formData.set("quality",state.draft.quality);formData.set("ratio",state.draft.ratio);formData.set("seconds",state.draft.seconds);formData.set("steps",state.draft.steps);formData.set("seed",state.draft.seed.trim());formData.set("gpu_target",gpuTarget);
    formData.set("character_ids",JSON.stringify(Array.from(state.selectedCharacterIds)));formData.set("location_ids",JSON.stringify(Array.from(state.selectedLocationIds)));formData.set("misc_ids",JSON.stringify(Array.from(state.selectedMiscIds)));
    if(firstFrameInput?.files?.[0])formData.set("first_frame",firstFrameInput.files[0]);if(lastFrameInput?.files?.[0])formData.set("last_frame",lastFrameInput.files[0]);
    let endpoint="/api/v2/generate";
    if(audioSubmission.enabled){endpoint="/api/v2/audio";formData.set("track_id",audioSubmission.trackId||"");if(audioSubmission.uploadedAudio)formData.set("audio",audioSubmission.uploadedAudio);formData.set("audio_start",String(audioSubmission.audioStart??0));formData.set("embed_track",audioSubmission.embedTrack?"true":"false");formData.set("generate_scene_audio",audioSubmission.generateSceneAudio?"true":"false");}
    else{formData.set("generate_audio",state.draft.audio?"true":"false");formData.set("muted_character_ids",JSON.stringify(api.mutedCharacterIds?.()||[]));}
    if(generateButton){generateButton.disabled=true;generateButton.classList.add("is-loading");}if(generateLabel)generateLabel.textContent="Добавляем в очередь…";
    try{const result=await fetchJson(endpoint,{method:"POST",body:formData});const id=String(result?.job_id||"").slice(0,8),r=result?.v2,res=r?.width&&r?.height?" · "+r.width+"×"+r.height:"",name=gpuTarget==="rtx2080"?"RTX2080":"RTX3090";showToast("Задача запущена на "+name+(id?" · "+id:"")+res);closeGpuDialog();api.setView?.("queue");setTimeout(()=>api.refreshSystem?.(),500);}
    catch(error){showToast("Не удалось запустить генерацию: "+error.message,"error");}
    finally{gpuSubmitting=false;generateButton?.classList.remove("is-loading");if(generateLabel)generateLabel.textContent="Сгенерировать видео";updateCreateCompatibility();if(gpuDialog?.open)await refreshGpuSlots();}
  };
  createForm?.addEventListener("submit",async e=>{e.preventDefault();const req=validateCreateRequest();if(req)await openGpuDialog();});
  gpuButtons.forEach(b=>b.addEventListener("click",async()=>{if(b.disabled||gpuSubmitting)return;const req=validateCreateRequest();if(!req){closeGpuDialog();return;}await submitCreate(String(b.dataset.v2GpuTarget||""),req,b);}));
  gpuDialogClose?.addEventListener("click",closeGpuDialog);gpuDialog?.addEventListener("close",stopGpuPolling);gpuDialog?.addEventListener("cancel",()=>{if(!gpuSubmitting)stopGpuPolling();});

  const restoreDraftToUi = () => {
    if (prompt) prompt.value = state.draft.prompt;
    if (seed) seed.value = state.draft.seed;
    if (audio) audio.checked = Boolean(state.draft.audio);
    ["quality", "ratio", "seconds", "steps"].forEach((key) => applySegment(key, state.draft[key], false));
    updatePromptCount();
    updateCreateCompatibility();
  };

  Object.assign(api, {
    applySegment,
    updatePromptCount,
    updateCreateCompatibility,
    restoreDraftToUi,
    resolvedVideoSize,
  });
})();