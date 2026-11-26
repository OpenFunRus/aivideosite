/* Hand-crafted first/last-frame transitions for MiniMax H3. No source audio is referenced. */
(() => {
  "use strict";

  const opening = "FIRST/LAST FRAME VIDEO TRANSITION. The FIRST supplied image is the exact last retained frame of video A. The SECOND supplied image is the exact first retained frame of video B. These are fixed visual endpoints and may show completely different locations, times, weather or characters. Briefly honor the composition of A, perform the specific transition described below, and arrive precisely at B's original framing, geometry, subjects, clothing and lighting. Adapt the pacing to the requested duration; compress the movement for short transitions without adding unrelated scenes. Do not force two different environments to be one room, continue an actor's previous performance, merge faces, morph people into objects, change endpoint identities or freeze on either image. Characters do not speak or move their lips to form words.";
  const ending = "Keep the camera movement legible and the two boundary frames faithful. Any dust, props, silhouettes, light or structures introduced for the transition appear only in the traveling middle, never as permanent additions to either endpoint. Avoid a broken frame, melting textures, unrelated third locations or a random jump in perspective.";
  const soundRules = "Only the described physical transition sound effects are permitted; synchronize their rise, peak and decay to the camera movement. ABSOLUTELY NO dialogue, narration, whispers, singing, grunts, voices, zombie screams, guitar, strumming, piano, drums, strings, instruments, melodies, rhythmic beats, songs, radio, background score or random noises.";

  const groups = [
    {
      id: "survival", name: "☣ 7 Days to Die", description: "Суровые переходы постапокалипсиса",
      items: [
        {
          id: "survival-dust", name: "Пыль забытой дороги", description: "Рывок над асфальтом, ржавый указатель и стена пыли.",
          visual: "A dry, desolate survival-world camera flight. From the FIRST image the lens drops to a low, fast glide as though skimming cracked asphalt; a weathered roadside sign flashes past in the transitional space, followed by a rolling wall of ochre dust that fills the entire view. Within the swirling grit the direction of motion stays coherent, then the wind thins and the camera rises into the SECOND image. Make the dust a practical natural occlusion that hides a genuine change of place, never a magical transformation of the original subjects. Keep sun glare and weathered textures plausible; let the final reveal feel like reaching the next lonely stretch of a dead world.",
          sound: "A close, dry wind gust grows into a gritty, low camera-flight WHOOSH. Fine sand skitters against the imagined lens, with one brief hollow metallic flutter as the sign flashes past; the grit settles into a small airy tail on arrival. No explosions or unexplained impacts."
        },
        {
          id: "survival-barricade", name: "Сквозь баррикаду", description: "Камера проскальзывает между досками разрушенного убежища.",
          visual: "A tense, grounded post-apocalyptic passage through a ruined barricade. The camera leaves the FIRST image with a determined forward push, accelerates toward a near-lens gap between warped planks and torn wire visible only during the transition, then slips through the tight opening. Rough wood and rusted metal sweep across the frame with convincing near-field parallax, momentarily obscuring everything; on the far side, the light and space resolve naturally into the SECOND image. The barricade is a brief spatial bridge, not a new persistent building and not proof that both endpoints share one location. The move should feel like an experienced survivor finding an opening without slowing down.",
          sound: "A short hollow airflow rush under a close woody scrape, a quick soft wire vibration and a clean pass-through WHOOSH. The sounds stop as the camera clears the barricade, leaving a subtle matching ambient tail; no smashing soundtrack, gunshots or voices."
        },
        {
          id: "survival-shadow", name: "Тень заражённого", description: "Мимо объектива проносится силуэт, закрывая смену сцены.",
          visual: "A frightening but elegant survival-horror foreground wipe. From the FIRST image the camera begins a cautious sidestep, then accelerates sideways as one out-of-focus, human-sized infected silhouette unexpectedly crosses very close to the lens. Its dark shoulder and ragged clothing occupy the entire frame for an instant, creating a complete natural occlusion; when the shape clears, the camera is already in the entirely different SECOND location. Keep the fleeting silhouette anonymous, believable, non-violent and confined to the middle of the transition. Do not turn any person from A into a zombie or insert an infected into B. The effect relies on suspense, silhouette and timing rather than gore or a monster close-up.",
          sound: "An urgent lateral air-swish accompanies the camera move, followed by a single close fabric flutter and a muffled low whoosh while the silhouette blocks the lens. The air opens cleanly onto B. Absolutely no moans, groans, screams or creature vocals."
        },
        {
          id: "survival-embers", name: "Искры после заката", description: "Пролёт через дым, тёплые искры и обугленные тени.",
          visual: "A cinematic dusk transition with the texture of a dying apocalypse. The camera peels away from the FIRST image and arcs beside a fleeting, half-seen patch of smoky wreckage in the transitional space. Warm orange embers and charcoal-gray smoke stream past the lens in a powerful directional gust; their layered depth and momentary near-total occlusion make it possible to leave one setting and enter another. The last ember drifts out of frame as the haze parts and reveals the SECOND image exactly, preserving its actual color temperature even if it is daylight or indoors. Make the effect physical and restrained: no giant explosions, fireballs, burning people or fantastical portals.",
          sound: "A low warm rush of moving air, a few tiny dry ember crackles and a soft smoky WHOOSH that sweeps across the stereo field. The crackle disappears as the frame clears; no cinematic music, percussion or explosive booms."
        },
        {
          id: "survival-rooftop", name: "Прыжок через руины", description: "Вертикальный рывок над сломанной крышей с облаком штукатурки.",
          visual: "An agile rooftop escape shot in a decayed survival landscape. Depart the FIRST image with a sudden upward camera lift, crest an old broken roofline appearing briefly in the transitional middle, then tip into a controlled forward dive. Jagged shingles, a splintered beam and a veil of pale plaster dust rush past at different depths, giving the descent real momentum. As the dust passes across the frame, change the geographical setting; ease out of the dive and land smoothly on the SECOND image without implying the new location must physically be inside the old house. No visible player character jumps, no supernatural teleport flash, just a spirited first-person camera maneuver through the remnants of a ruined world.",
          sound: "A rising rooftop wind rush becomes a descending airy WHOOSH, accented by a brief dry shingle rattle and a whisper of falling plaster grit. The rush softens exactly when the camera stabilizes; no footsteps, screams or musical sting."
        }
      ]
    },
    {
      id: "cinema", name: "🎬 Кинематографичные", description: "Камерные приёмы большого кино",
      items: [
        {
          id: "cinema-flight", name: "Сквозной полёт", description: "Фирменный мощный пролёт с ускорением и мягкой посадкой.",
          visual: "An expansive, premium feature-film fly-through connecting two genuinely separate scenes. Begin by perfectly honoring the FIRST image, then launch the virtual camera into a purposeful forward dolly that accelerates into a sweeping passage with strong foreground-to-background parallax. The scenery of A falls away; a single plausible near-lens surface or natural motion-blurred obstruction conceals the spatial jump, then the camera emerges into the air and perspective of B. In the final moments it slows with controlled inertia, settles its horizon and lands with the precise focal composition and visual details of the SECOND image. This should feel like one masterfully operated camera, not actors continuing the same scene or a random montage.",
          sound: "One polished, full-bodied cinematic air WHOOSH: a restrained intake at departure, a rich but clean low-mid rush at peak speed, and a beautifully timed airy falloff as the camera lands. No bass drop, music, instruments or arbitrary impacts."
        },
        {
          id: "cinema-whip", name: "Хлыст камеры", description: "Резкая панорама, полосы движения и мгновенное раскрытие B.",
          visual: "A precise high-end whip-pan transition, executed as a single camera gesture. Hold the FIRST composition just long enough to orient the viewer, then swing the camera sharply sideways with consistent directional motion blur and stretched highlights. The middle becomes a readable sweep of color and moving edges rather than recognizable actors; during this natural motion blur the geographical scene changes completely. Decelerate the exact same pan direction and allow the SECOND image to snap into crisp focus at the correct horizon and framing, without a jarring cut or a face morph. Let the move be bold, short and confident, as if an expert camera operator discovered the next scene mid-swing.",
          sound: "A taut, fast left-to-right airy SWISH with a subtle low-frequency pressure pass and a short clean stop at the new framing. Precisely one sound gesture; no strings, drums, trailer hit or voices."
        },
        {
          id: "cinema-match", name: "Визуальная рифма", description: "Форма перед камерой скрывает смену пространства.",
          visual: "An elegant match-on-shape camera transition that respects both independent endpoint images. Leave the FIRST image with a small lateral tracking move toward an existing strong geometric edge, shadow or broad foreground silhouette. A similarly shaped dark or bright near-lens plane slides across and briefly fills the picture; hidden inside this continuous occlusion the location changes to B. Pull away from a corresponding edge in the new setting and reveal the SECOND image at its exact original scale and framing. The similarity is purely graphic, not a transformation: never morph a face, character, vehicle or building from A into a different object in B. Aim for the satisfying visual rhyme of a carefully planned editorial transition.",
          sound: "A silky, close microphone-like air pass follows the crossing foreground surface, with one very soft muted swish at full occlusion and a gentle room-tone handoff. No clunks unless a visible surface justifies them, and absolutely no musical chord."
        },
        {
          id: "cinema-vertical", name: "Вверх и вниз", description: "Камера взмывает, пересекает нейтральное пространство и ныряет в B.",
          visual: "A graceful vertical camera maneuver with real cinematic scale. From the FIRST image crane rapidly upward, tipping past the ceiling line, clouds, bright overhead opening or another believable high-contrast upper plane appropriate to that environment. For a moment the transitional frame is occupied by sky, ceiling light or a close passing overhead surface, not by a new unrelated story. The camera carries its upward momentum through this soft spatial occlusion and curves into a controlled downward reveal of a different place. Descend, slow and precisely settle into the SECOND image. Respect both endpoint geometries; if a literal sky would be impossible, use an overhead interior surface instead. No teleportation portal or character levitation.",
          sound: "A thin rising vertical wind whistle deepens into a broad airy camera WHOOSH through the overhead pass, then falls smoothly in pitch and intensity as the lens tilts down. Natural air pressure movement only, never melody or a dramatic score."
        },
        {
          id: "cinema-flare", name: "Световой мост", description: "Оптический блик заполняет кадр и открывает другое место.",
          visual: "A refined optical transition motivated by the camera moving across a practical light source or reflective surface. Begin at the FIRST image, then make a gentle accelerating camera move past a believable bright edge; realistic lens bloom and a soft streak of flare expand until the intervening scene is briefly obscured by luminous exposure. Do not use a white graphic wipe, magic sparkles or a computer-generated portal. Allow the flare to contract naturally as the camera completes its movement in a different environment, revealing the SECOND image with exactly its intended colors, exposure and composition. The effect should feel photographed with real glass and light, understated yet unmistakably cinematic.",
          sound: "A subtle transparent air sweep with a small smooth pressure rise as the flare crosses the lens, then a delicate airy decay. No shimmering synth, bells, chimes, electric buzz, guitar or music of any kind."
        }
      ]
    },
    {
      id: "simple", name: "✨ Простые", description: "Чистые переходы без лишней драматургии",
      items: [
        {
          id: "simple-dissolve", name: "Мягкое растворение", description: "Чистый наплыв между A и B, без путешествия камеры.",
          visual: "A simple, beautiful editorial cross-dissolve between two separate still-boundary scenes. The FIRST image remains accurate at the opening. Then gently lower its opacity as the SECOND image naturally emerges, blending lighting and texture for a short, balanced overlap without inventing new scenery or forcing objects to morph into each other. By the end, B is fully opaque, sharp and perfectly aligned with its supplied endpoint. Camera movement is minimal or absent; the transition itself is the gradual photographic dissolve, suitable for quiet narrative pacing. Avoid a dip to black, dramatic zoom, lens flash, added characters or an extended hold on a halfway composite.",
          sound: "A nearly silent, soft breath of air accompanies the visual dissolve and gradually gives way to the second scene's neutral ambience. No dramatic whoosh, booming impact, musical notes or voices."
        },
        {
          id: "simple-pan", name: "Панорама вправо", description: "Один понятный боковой взмах камеры.",
          visual: "A clean, straightforward rightward camera pan from the FIRST scene into the SECOND scene. Start at the exact first boundary, rotate the camera gently but decisively to the right until motion blur briefly hides the surroundings, and recover naturally into the exact second boundary. Keep the sweep on one consistent horizontal axis, with no 3D tunnel, dust storm, new actors or flashy effects. The locations may be completely unrelated; the short middle blur is the intentional editorial bridge between them. Stop with a steady horizon and clear framing. The result should be practical, usable and almost invisible as an editing trick.",
          sound: "One small clean rightward swish of air that peaks at the center of the pan and disappears when the camera stops. No music or extra sound events."
        },
        {
          id: "simple-zoom", name: "Лёгкий зум", description: "Небольшое приближение и плавное раскрытие второй картинки.",
          visual: "A restrained camera push-in transition. Begin with the accurate FIRST image, perform one steady forward move with a mild natural radial motion blur as the camera passes close to a neutral surface, then pull the blur out of the SECOND scene and come to rest on its exact composition. Keep the scale change small, elegant and physically motivated; this is not a warp-speed tunnel or a dramatic dive. Never stretch faces or bend architecture to manufacture a match. The purpose is to move the viewer gently between separate places while letting the source images do the storytelling.",
          sound: "A short soft forward air whoosh with a smooth rise and a quiet end. No hit, engine noise, tonal sweep, music or speech."
        },
        {
          id: "simple-occlusion", name: "За объектом", description: "Близкий объект на миг закрывает весь объектив.",
          visual: "A natural, discreet foreground-occlusion transition. The camera makes a small sideways move away from the FIRST image while a nearby wall edge, post, curtain, tree trunk or other broad surface appropriate to the shot passes very close across the lens. For a brief moment the texture fills the entire frame; as the camera clears the obstacle, the SECOND scene is revealed perfectly. The obstacle only exists during the transition and is not forced into either source image. No dramatic effects, supernatural morphing, black flash or sudden unrelated subjects. It should look like a useful trick a documentary camera operator could perform on location.",
          sound: "A gentle close-range air brushing sound, perhaps the faintest surface rustle if appropriate, fading instantly as the obstacle clears. No musical cue or voice."
        },
        {
          id: "simple-tilt", name: "Через верх кадра", description: "Подъём к небу или потолку и мягкий спуск в новую сцену.",
          visual: "A simple, unhurried tilt transition. From the FIRST image the camera tilts upward into an uncluttered upper portion of the environment—sky outdoors, ceiling indoors, or a broad light neutral surface—until it briefly occupies most of the picture. While the view is hidden by this believable plane, change to the unrelated SECOND location and tilt downward into the exact final framing. Keep the movement modest and continuous, with gentle acceleration and deceleration. Do not add new characters, fly through a fantasy portal or invent an elaborate intermediate environment. Favor readability and a natural sense of time passing.",
          sound: "A light rising and falling breath of moving air, almost inaudible, timed to the camera tilt. No guitar, soundtrack, atmospheric melody or voices."
        }
      ]
    }
  ];

  function fullPrompt(item) {
    return [
      "integrated_multimodal_description: [Shot 1] " + opening + " " + item.visual + " " + ending,
      "overall_soundscape: " + item.sound + " " + soundRules,
      "non_diegetic_music: N/A",
      "speech_policy: silent",
    ].join("\n\n");
  }

  const ready = groups.map(group => ({
    ...group,
    items: group.items.map(item => ({ ...item, prompt: fullPrompt(item) })),
  }));
  window.AIVideoSplicePresets = Object.freeze({ groups: ready, defaultId: "cinema-flight" });
})();
