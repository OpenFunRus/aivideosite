# V2 — единый дизайн генератора

Статус: актуальный визуальный контракт V2 после объединения обычного Video и audio-driven Digital Human в одну страницу **«Видео»**.

## Общий каркас

- Один page title в `layout/topbar.html`, без дублирующего заголовка внутри формы.
- Под ним: короткое пояснение, prompt, First/Last, опциональная аудиодорожка, общие настройки, основная кнопка.
- `.v2-generator-form`: единая ширина и 14px между блоками.
- Правая панель Presets постоянна: Characters / Locations / «Прочее».
- Общие настройки Video: **Качество / Формат / Длительность / Шаги / Seed**.
- Обычная генерация использует галочку **«Генерировать звук»**.
- При включении **«Использовать аудиодорожку»** обычная галочка звука скрывается и появляются:
  - saved/uploaded master track;
  - waveform с выбором начала фрагмента;
  - **«Вклеить трек в видео»**;
  - **«Фоновые звуки H3»**.

## First / Last

First Frame и Last Frame всегда находятся в основном Video UI.

- обычный режим без semantic presets: FL2VA endpoints;
- presets + First/Last: semantic Ref2VA + native exact Timeline Guides;
- driving-audio mode: Digital Human + driving audio, а First/Last закрепляются отдельно через native `MiniMaxH3AddGuide`.

Отдельного произвольного visual-reference upload для driving-audio режима нет.

## Prompt / Magic Wand

В V2 одна Magic Wand на странице Video.

- normal mode: обычные FL2VA / Ref2VA / Timeline правила;
- audio mode: Digital Human, master track уже является driving audio;
- `non_diegetic_music: N/A` в audio mode;
- First/Last в audio mode не получают FL2VA alignment line, потому что backend прикладывает их отдельными exact guides.

## Где править

- Основная разметка: `app/templates/v2/views/create.html`.
- Основная логика формы: `app/static/v2/js/create.js`.
- Audio-track controller / waveform: `app/static/v2/js/workspaces/audio.js`.
- Общие стили генератора: `app/static/v2/css/create.css` и `app/static/v2/css/workspaces/generator-design.css`.
- Стили integrated audio block: `app/static/v2/css/workspaces/audio.css`.
- Backend routes: `POST /api/v2/generate` и внутренний audio-mode route `POST /api/v2/audio`.
- Comfy workflow: `app/comfy.py`.

Отдельной V2 страницы `views/audio.html` больше нет.
