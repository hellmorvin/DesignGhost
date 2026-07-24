<p align="center">
  <img src="icons/1.png" width="120" alt="DesignGhost Logo" style="border-radius: 24px; box-shadow: 0 8px 24px rgba(0,0,0,0.25);">
</p>

<h1 align="center">DesignGhost</h1>

<p align="center">
  <b>Ультимативное браузерное расширение (Manifest V3) для кастомизации веб-интерфейсов в реальном времени с автосохранением.</b>
</p>

<p align="center">
  <a href="https://github.com/hellmorvin/DesignGhost">
    <img src="https://img.shields.io/badge/DesignGhost-v1.1.0-818cf8?style=for-the-badge" alt="Version">
  </a>
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript">
  <img src="https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white" alt="CSS3">
  <img src="https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white" alt="HTML5">
  <img src="https://img.shields.io/badge/Chrome_Extension-MV3-4285F4?style=for-the-badge&logo=google-chrome&logoColor=white" alt="Chrome Extension">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License">
</p>

---

> [!CAUTION]
> ### 🛑 ВНИМАНИЕ: ОСТЕРЕГАЙТЕСЬ ФЕЙКОВ / FAKE CLONES!
> Я не веду никакие другие страницы/группы в Telegram или каналы на YouTube.
> Если вы наткнулись на файлы, сборки или архивы в сети вне этой официальной страницы GitHub, распространяемые от моего лица — **это ФЕЙК**.
> 
> Загружайте и используйте расширение **исключительно** из проверенного официального репозитория автора: **[github.com/hellmorvin](https://github.com/hellmorvin/)**. Другие источники могут содержать вредоносные скрипты и вирусы, ворующие персональные данные.

---

## 📷 Скриншоты работы / Preview

<table align="center" style="border: none; background: transparent;">
  <tr style="border: none; background: transparent;">
    <td align="center" style="border: none; background: transparent; padding: 4px;">
      <kbd><img src="assets/screenshot1.png" width="240" alt="Редактор CSS"></kbd>
      <br><sub><b>Редактор CSS и JS консоль</b></sub>
    </td>
    <td align="center" style="border: none; background: transparent; padding: 4px;">
      <kbd><img src="assets/screenshot2.png" width="240" alt="Включение Инспектора"></kbd>
      <br><sub><b>Инспектор DOM и поиск</b></sub>
    </td>
    <td align="center" style="border: none; background: transparent; padding: 4px;">
      <kbd><img src="assets/screenshot3.png" width="240" alt="Инспектор элементов"></kbd>
      <br><sub><b>Настройка классов и атрибутов</b></sub>
    </td>
  </tr>
</table>

---

## 🌟 Основные возможности

*   **⚡ Удобный CSS-редактор**:
    *   Полноценная подсветка номеров строк, автоотступы (`Tab`), автозакрытие парных скобок и кавычек.
    *   Форматирование и быстрая очистка CSS-кода.
    *   Кодирование изображений с компьютера в Base64 `url("data:image/...")` прямо на позицию курсора.
*   **🌐 Выбор области сохранения (Scoping)**:
    *   Сохраняйте изменения для **всего домена** (например, `site.com`) или точечно для **конкретной страницы** (например, `site.com/subpage`).
    *   Каскадный импорт: индивидуальные правила страницы гармонично перекрывают глобальные правила домена.
*   **💻 Интерактивная JS-консоль**:
    *   Встроенный терминал для выполнения скриптов в контексте страницы (Main World).
    *   Интеграция с консолью страницы: перехват и форматирование `console.log`, `console.warn` и `console.error`.
    *   История команд с навигацией по стрелочкам **Вверх / Вниз**.
*   **🔎 Умный поиск по элементам DOM**:
    *   Поиск элементов на странице по CSS-селекторам или текстовому содержимому.
    *   Быстрые действия: подсветить элемент на странице (эффект вспышки), скрыть элемент или мгновенно перейти к его редактированию в инспекторе.
*   **🔍 Улучшенный оверлей-инспектор DOM**:
    *   Удобный выбор элементов на странице кликом мыши.
    *   Редактор стилей ползунками (шрифт, скругления, прозрачность, цвета, отступы, фоновые картинки).
    *   Редактирование сырого HTML кода выбранного элемента.
    *   **Управление классами & атрибутами**: добавление/удаление CSS-классов и редактирование кастомных атрибутов элемента.
    *   Мгновенное скрытие или полное удаление рекламы/мусора.
    *   Замена картинок (`<img>`) на свои локальные с Canvas-сжатием.
*   **🖼️ Умное сжатие изображений**:
    *   Все загружаемые файлы автоматически пережимаются на лету через HTML5 Canvas (макс. 1200px, качество 0.8 JPEG).
*   **💾 Бэкап и Сайты**:
    *   Экспорт и импорт всех кастомных правил в единый JSON-файл.
    *   Удобный список сайтов с активными правилами и быстрым сбросом.

---

## 🚀 Установка расширения в браузер

Для установки расширения в режиме разработчика:

1.  Скачайте этот репозиторий в виде ZIP-архива и распакуйте его или выполните команду клонирования:
    ```bash
    git clone https://github.com/hellmorvin/DesignGhost.git
    ```
2.  Откройте браузер на базе Chromium (Google Chrome, Яндекс.Браузер, Brave, Opera, Edge).
3.  Перейдите по адресу: **`chrome://extensions/`**
4.  Включите **«Режим разработчика»** (Developer mode) в правом верхнем углу.
5.  Нажмите кнопку **«Загрузить распакованное расширение»** (Load unpacked) в левом верхнем углу.
6.  Выберите корневую папку с проектом (ту, где находится файл `manifest.json`).
7.  Закрепите иконку **DesignGhost** на панели браузера.

---

## 📂 Архитектура проекта

```bash
├── assets/
│   ├── screenshot1.png   # Скриншот редактора кастомных стилей
│   ├── screenshot2.png   # Скриншот DOM-инспектора в работе
│   └── screenshot3.png   # Скриншот интерфейса инспектора
├── background/
│   └── background.js     # Фоновый сервис-воркер расширения для управления иконками и бейджами
├── content/
│   ├── content.css       # Стили инспектора и всплывающего виджета на страницах
│   └── content.js        # Скрипт инспектора и инжектор пользовательских CSS правил
├── icons/
│   ├── 1.png             # Исходный логотип высокого разрешения
│   ├── icon16.png        # Иконки расширения разного разрешения
│   ├── icon48.png
│   └── icon128.png
├── popup/
│   ├── popup.css         # Стилизация главного окна управления (темная тема)
│   ├── popup.html        # Разметка окон управления, списков правил и CSS редактора
│   └── popup.js          # Контроллер редактора кода, экспорта, импорта и перехода на DonationAlerts
├── .gitignore            # Исключение лишних файлов из Git
├── LICENSE               # Файл открытой лицензии MIT
├── manifest.json         # Манифест конфигурации расширения (Manifest V3)
└── README.md             # Документация проекта
```

---

## ⭐ Поддержка проекта

Вы можете поддержать проект следующими способами:
1. Поставьте **Звезду** ⭐ этому репозиторию (в верхнем правом углу этой страницы).
2. Вы можете материально поддержать оригинального разработчика **DesignGhost** (morvin) через DonationAlerts по ссылке:  
   👉 **[Открыть DonationAlerts для поддержки morvin](https://www.donationalerts.com/r/hellmorvin)**

Большое спасибо за поддержку развития проекта!

---

## ⚖️ Лицензирование

Проект распространяется на условиях открытой лицензии **MIT License**. Вы можете свободно модифицировать и использовать этот код.

Разработчик: **[morvin](https://github.com/hellmorvin/)**
