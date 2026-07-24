/**
 * DesignGhost - Popup controller
 * Controls tabs, editors, rule states, import/export, and page communications.
 */

(function () {
  'use strict';

  let activeTab = null;
  let activeHostname = '';
  let activeUrl = '';
  let storageKey = '';
  let activeDomainData = { css: '', htmlRules: [], enabled: true };

  // Normalize URL to handle trailing slashes, hashes, and strip queries consistently
  function normalizeUrl(url) {
    if (!url) return '';
    try {
      const urlObj = new URL(url);
      let pathname = urlObj.pathname;
      if (pathname.endsWith('/') && pathname.length > 1) {
        pathname = pathname.slice(0, -1);
      }
      let hash = urlObj.hash;
      if (hash.includes('?')) {
        hash = hash.split('?')[0];
      }
      return urlObj.origin + pathname + hash;
    } catch (e) {
      return url;
    }
  }

  // Image compression and resize helper (downscale to max 1200px and compress to 0.8 JPEG quality)
  function compressAndResizeImage(file, maxDimension = 1200, quality = 0.8) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;

          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height * maxDimension) / width);
              width = maxDimension;
            } else {
              width = Math.round((width * maxDimension) / height);
              height = maxDimension;
            }
          }

          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          // Convert to compressed jpeg data url
          const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
          resolve(compressedDataUrl);
        };
        img.onerror = () => reject(new Error('Ошибка загрузки картинки для сжатия'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Ошибка чтения файла'));
      reader.readAsDataURL(file);
    });
  }

  // Run initial loading
  document.addEventListener('DOMContentLoaded', initPopup);

  function initPopup() {
    setupTabControls();
    
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) {
        showErrorState('Не удалось определить вкладку');
        return;
      }
      
      const tab = tabs[0];
      activeTab = tab;
      activeUrl = normalizeUrl(tab.url);

      if (!tab.url || 
          tab.url.startsWith('chrome://') || 
          tab.url.startsWith('chrome-extension://') || 
          tab.url.startsWith('edge://') || 
          tab.url.startsWith('about:') || 
          tab.url.startsWith('view-source:')) {
        showErrorState('Недоступно на системных страницах');
        return;
      }

      try {
        const urlObj = new URL(tab.url);
        activeHostname = urlObj.hostname;
      } catch (e) {
        showErrorState('Некорректный адрес страницы');
        return;
      }

      // Load directly from local storage first to prevent race conditions
      chrome.storage.local.get(['siteTweaks', 'activeScopes'], (storageResult) => {
        const allTweaks = storageResult.siteTweaks || {};
        const activeScopes = storageResult.activeScopes || {};
        
        // Determine whether page-specific or domain-specific settings exist
        if (activeScopes[activeHostname] === 'domain') {
          storageKey = activeHostname;
        } else {
          storageKey = activeUrl;
        }
        
        const domainData = allTweaks[storageKey] || { css: '', js: '', html: '', htmlRules: [], enabled: true };

        // Query the content script for inspector status
        chrome.tabs.sendMessage(tab.id, { action: 'GET_DOM_INFO' }, (response) => {
          let isInspectMode = false;
          if (chrome.runtime.lastError || !response) {
            injectContentScript(tab, domainData);
          } else {
            isInspectMode = response.isInspectMode;
            setupUI({
              hostname: activeHostname,
              css: domainData.css || '',
              js: domainData.js || '',
              html: domainData.html || '',
              htmlRules: domainData.htmlRules || [],
              enabled: domainData.enabled !== false,
              isInspectMode: isInspectMode
            });
          }
        });
      });
    });

    // Populate the general Settings Sites and Backups
    renderSitesList();
    setupBackupControls();
    setupConsole();
    setupDOMSearch();
  }

  // Inject content script and stylesheet if missing
  function injectContentScript(tab, domainData) {
    showStatus('Внедрение расширения...', 'working');
    
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content.js']
    }, () => {
      if (chrome.runtime.lastError) {
        showErrorState('Ошибка доступа к странице: ' + chrome.runtime.lastError.message);
        return;
      }

      chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content/content.css']
      }, () => {
        if (chrome.runtime.lastError) {
          console.warn('CSS Injection issue:', chrome.runtime.lastError.message);
        }

        setupUI({
          hostname: activeHostname,
          css: domainData.css || '',
          js: domainData.js || '',
          html: domainData.html || '',
          htmlRules: domainData.htmlRules || [],
          enabled: domainData.enabled !== false,
          isInspectMode: false
        });
      });
    });
  }

  // Setup main UI functions when domain info is successfully retrieved
  function setupUI(data) {
    activeHostname = data.hostname || activeHostname;
    activeDomainData = {
      css: data.css || '',
      htmlRules: data.htmlRules || [],
      enabled: data.enabled !== false
    };

    // Update Header Domain name & switch
    const domainLabel = document.getElementById('current-domain');
    domainLabel.textContent = activeHostname;
    domainLabel.style.color = '';

    const domainToggle = document.getElementById('domain-enable-toggle');
    domainToggle.checked = activeDomainData.enabled;
    domainToggle.disabled = false;
    
    domainToggle.onchange = (e) => {
      const isEnabled = e.target.checked;
      activeDomainData.enabled = isEnabled;
      
      chrome.storage.local.get(['siteTweaks'], (result) => {
        const allTweaks = result.siteTweaks || {};
        allTweaks[storageKey] = {
          ...allTweaks[storageKey],
          enabled: isEnabled
        };
        chrome.storage.local.set({ siteTweaks: allTweaks }, () => {
          chrome.tabs.sendMessage(activeTab.id, { action: 'RELOAD_STORAGE' }, () => {
            showStatus(isEnabled ? 'Изменения включены' : 'Изменения отключены', 'online');
          });
        });
      });
    };

    // Scope Selection Binding
    const scopeSelect = document.getElementById('scope-select');
    if (scopeSelect) {
      scopeSelect.value = (storageKey === activeUrl) ? 'page' : 'domain';
      scopeSelect.onchange = (e) => {
        const newScope = e.target.value;
        storageKey = (newScope === 'page') ? activeUrl : activeHostname;
        
        chrome.storage.local.get(['siteTweaks', 'activeScopes'], (res) => {
          const activeScopes = res.activeScopes || {};
          activeScopes[activeHostname] = newScope;
          chrome.storage.local.set({ activeScopes }, () => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              if (tabs[0] && tabs[0].id) {
                chrome.tabs.sendMessage(tabs[0].id, { action: 'RELOAD_STORAGE' }).catch(() => {});
              }
            });
          });
          
          const tweaks = res.siteTweaks || {};
          const activeData = tweaks[storageKey] || { css: '', htmlRules: [], enabled: true };
          
          activeDomainData = {
            css: activeData.css || '',
            htmlRules: activeData.htmlRules || [],
            enabled: activeData.enabled !== false
          };
          
          const cssEditor = document.getElementById('css-editor');
          if (cssEditor) {
            cssEditor.value = activeDomainData.css;
            const lineNumbers = document.getElementById('editor-line-numbers');
            if (lineNumbers) {
              const count = cssEditor.value.split('\n').length;
              let htmlStr = '';
              for (let i = 1; i <= count; i++) {
                htmlStr += i + '<br>';
              }
              lineNumbers.innerHTML = htmlStr;
            }
          }
          
          domainToggle.checked = activeDomainData.enabled;
          renderHTMLRulesList();
          showStatus(newScope === 'page' ? 'Смена области: страница' : 'Смена области: домен', 'online');
        });
      };
    }

    // Helper to make gutters scroll-synced, tab-indented, and bracket-closed
    function makeEditorInteractive(textareaId, gutterId) {
      const textarea = document.getElementById(textareaId);
      const gutter = document.getElementById(gutterId);
      if (!textarea) return null;

      const updateGutter = () => {
        if (!gutter) return;
        const count = textarea.value.split('\n').length;
        let htmlStr = '';
        for (let i = 1; i <= count; i++) {
          htmlStr += i + '<br>';
        }
        gutter.innerHTML = htmlStr;
        gutter.scrollTop = textarea.scrollTop;
      };

      textarea.oninput = updateGutter;
      textarea.onscroll = () => {
        if (gutter) gutter.scrollTop = textarea.scrollTop;
      };

      textarea.onkeydown = (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const start = textarea.selectionStart;
          const end = textarea.selectionEnd;
          textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
          textarea.selectionStart = textarea.selectionEnd = start + 2;
          updateGutter();
        }

        const pairs = {
          '{': '}',
          '(': ')',
          '[': ']',
          '"': '"',
          "'": "'"
        };
        if (pairs[e.key] !== undefined) {
          e.preventDefault();
          const start = textarea.selectionStart;
          const end = textarea.selectionEnd;
          const closing = pairs[e.key];
          textarea.value = textarea.value.substring(0, start) + e.key + closing + textarea.value.substring(end);
          textarea.selectionStart = textarea.selectionEnd = start + 1;
          updateGutter();
        }
      };

      updateGutter();
      return updateGutter;
    }

    // Initialize Textareas Values
    const cssEditor = document.getElementById('css-editor');
    cssEditor.value = activeDomainData.css;
    cssEditor.disabled = false;

    // Run interactive bindings
    const updateCssGutter = makeEditorInteractive('css-editor', 'editor-line-numbers');

    // 1. CSS IMAGE INSERTION
    const btnInsertImgCss = document.getElementById('btn-insert-img-css');
    const cssInsertImgInput = document.getElementById('css-insert-img-input');

    if (btnInsertImgCss && cssInsertImgInput) {
      btnInsertImgCss.onclick = () => cssInsertImgInput.click();
      cssInsertImgInput.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        showStatus('Сжатие...', 'working');
        compressAndResizeImage(file, 1200, 0.8).then((dataUrl) => {
          const start = cssEditor.selectionStart;
          const end = cssEditor.selectionEnd;
          const urlStr = `url("${dataUrl}")`;
          
          cssEditor.value = cssEditor.value.substring(0, start) + urlStr + cssEditor.value.substring(end);
          cssEditor.selectionStart = cssEditor.selectionEnd = start + urlStr.length;
          cssEditor.focus();
          if (updateCssGutter) updateCssGutter();
          showStatus('Сжатая картинка вставлена', 'online');
        }).catch((err) => {
          showStatus('Ошибка сжатия изображения', 'offline');
        });
        cssInsertImgInput.value = '';
      };
    }

    // DonationAlerts Open Handler
    const btnSupportLink = document.getElementById('btn-support-link');
    if (btnSupportLink) {
      btnSupportLink.onclick = () => {
        chrome.tabs.create({ url: 'https://www.donationalerts.com/r/hellmorvin' });
      };
    }

    // Author GitHub Open Handler
    const linkAuthorGithub = document.getElementById('link-author-github');
    if (linkAuthorGithub) {
      linkAuthorGithub.onclick = (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: 'https://github.com/hellmorvin/' });
      };
    }

    // CSS actions
    document.getElementById('btn-save-css').onclick = () => {
      const newCss = cssEditor.value;
      activeDomainData.css = newCss;
      
      chrome.storage.local.get(['siteTweaks'], (result) => {
        const allTweaks = result.siteTweaks || {};
        allTweaks[storageKey] = {
          ...allTweaks[storageKey],
          css: newCss
        };
        chrome.storage.local.set({ siteTweaks: allTweaks }, () => {
          chrome.tabs.sendMessage(activeTab.id, { action: 'APPLY_CUSTOM_CSS', css: newCss }, () => {
            showStatus('CSS сохранен и применен!', 'online');
            renderSitesList();
          });
        });
      });
    };

    document.getElementById('btn-format-css').onclick = () => {
      let css = cssEditor.value;
      if (!css.trim()) return;

      showStatus('Форматирование...', 'working');
      try {
        css = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m + '\n'); // Keep comments
        css = css.replace(/\s*([\{\};,])\s*/g, '$1'); // Collapse whitespace
        css = css.replace(/\{/g, ' {\n  ');
        css = css.replace(/;/g, ';\n  ');
        css = css.replace(/\n\s*\}/g, '\n}\n');
        css = css.replace(/\}\s*\n*/g, '}\n\n');
        css = css.replace(/,\s*/g, ', ');
        css = css.replace(/:\s*/g, ': ');
        css = css.replace(/;/g, ';\n  '); // Double safety for declarations
        css = css.replace(/;/g, ';\n  ');
        css = css.replace(/;\s*([a-zA-Z\-])/g, ';\n  $1');

        let lines = css.split('\n');
        let indentLevel = 0;
        let formattedLines = lines.map(line => {
          line = line.trim();
          if (line.endsWith('}')) {
            indentLevel = Math.max(0, indentLevel - 1);
          }
          let indent = '  '.repeat(indentLevel);
          if (line.endsWith('{')) {
            indentLevel++;
          }
          return line ? indent + line : '';
        });

        cssEditor.value = formattedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        if (updateCssGutter) updateCssGutter();
        showStatus('Стиль отформатирован', 'online');
      } catch (err) {
        showStatus('Ошибка форматирования', 'offline');
      }
    };

    document.getElementById('btn-clear-css').onclick = () => {
      if (confirm('Вы уверены, что хотите очистить весь CSS код для этого сайта?')) {
        cssEditor.value = '';
        activeDomainData.css = '';
        if (updateCssGutter) updateCssGutter();
        
        chrome.storage.local.get(['siteTweaks'], (result) => {
          const allTweaks = result.siteTweaks || {};
          if (allTweaks[storageKey]) {
            allTweaks[storageKey].css = '';
          }
          chrome.storage.local.set({ siteTweaks: allTweaks }, () => {
            chrome.tabs.sendMessage(activeTab.id, { action: 'APPLY_CUSTOM_CSS', css: '' }, () => {
              showStatus('CSS очищен', 'online');
              renderSitesList();
            });
          });
        });
      }
    };

    // Inspector
    const inspectorBtn = document.getElementById('btn-toggle-inspector');
    const inspectorBtnText = document.getElementById('inspector-btn-text');
    
    if (data.isInspectMode) {
      inspectorBtn.classList.add('active');
      inspectorBtnText.textContent = 'Выключить Инспектор';
    }

    inspectorBtn.onclick = () => {
      const toEnable = !inspectorBtn.classList.contains('active');
      chrome.tabs.sendMessage(activeTab.id, { action: 'TOGGLE_INSPECTOR', enable: toEnable }, (res) => {
        if (res && res.isInspectMode) {
          inspectorBtn.classList.add('active');
          inspectorBtnText.textContent = 'Выключить Инспектор';
          window.close(); // Close popup so they can inspect
        } else {
          inspectorBtn.classList.remove('active');
          inspectorBtnText.textContent = 'Включить Инспектор';
        }
      });
    };

    // HTML Rules and Manual Adder
    renderHTMLRulesList();
    setupManualRuleForm();

    // Enable reset domain button
    const resetDomainBtn = document.getElementById('btn-reset-domain');
    resetDomainBtn.disabled = false;
    resetDomainBtn.onclick = () => {
      const displayKey = (storageKey === activeUrl) ? 'этой страницы' : `сайта ${activeHostname}`;
      if (confirm(`Вы уверены, что хотите сбросить все изменения для ${displayKey}?`)) {
        chrome.storage.local.get(['siteTweaks'], (result) => {
          const allTweaks = result.siteTweaks || {};
          delete allTweaks[storageKey];
          chrome.storage.local.set({ siteTweaks: allTweaks }, () => {
            activeDomainData = { css: '', htmlRules: [], enabled: true };
            cssEditor.value = '';
            if (updateCssGutter) updateCssGutter();
            
            domainToggle.checked = true;
            renderHTMLRulesList();
            renderSitesList();
            chrome.tabs.sendMessage(activeTab.id, { action: 'RELOAD_STORAGE' }, () => {
              showStatus('Изменения сброшены', 'online');
            });
          });
        });
      }
    };

    showStatus('Готов к работе', 'online');
  }

  // Tab controls logic
  function setupTabControls() {
    const navButtons = document.querySelectorAll('.nav-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');
    
    navButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTabId = btn.getAttribute('data-tab');
        
        navButtons.forEach(b => b.classList.remove('active'));
        tabPanes.forEach(p => p.classList.remove('active'));
        
        btn.classList.add('active');
        const pane = document.getElementById(targetTabId);
        if (pane) pane.classList.add('active');
      });
    });
  }

  // Renders saved rules for current website
  function renderHTMLRulesList() {
    const container = document.getElementById('html-rules-list');
    
    if (!activeDomainData.htmlRules || activeDomainData.htmlRules.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="9" y1="3" x2="9" y2="21"></line>
          </svg>
          <p>Нет активных правил для этого сайта.<br>Используйте Инспектор выше, чтобы скрыть или изменить элементы.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = '';

    activeDomainData.htmlRules.forEach((rule) => {
      const card = document.createElement('div');
      card.className = 'rule-card';

      let badgeText = 'Скрыть';
      let badgeClass = 'badge-hide';
      if (rule.action === 'remove') {
        badgeText = 'Удалить';
        badgeClass = 'badge-remove';
      } else if (rule.action === 'edit_html') {
        badgeText = 'HTML';
        badgeClass = 'badge-html';
      } else if (rule.action === 'edit_style') {
        badgeText = 'Стиль';
        badgeClass = 'badge-style';
      } else if (rule.action === 'edit_attribute') {
        badgeText = rule.attribute ? rule.attribute.toUpperCase() : 'АТРИБУТ';
        badgeClass = 'badge-attr';
      }

      let previewValHtml = '';
      if (rule.action === 'edit_html' && rule.value !== undefined) {
        const escaped = escapeHTML(rule.value);
        previewValHtml = `<span class="rule-preview-val" title="${escaped}">${escaped.substring(0, 30)}${escaped.length > 30 ? '...' : ''}</span>`;
      } else if (rule.action === 'edit_style' && typeof rule.value === 'object') {
        let stylesStr = '';
        for (const [prop, val] of Object.entries(rule.value)) {
          stylesStr += `${prop}: ${val}; `;
        }
        const escaped = escapeHTML(stylesStr);
        previewValHtml = `<span class="rule-preview-val" title="${escaped}">${escaped.substring(0, 30)}${escaped.length > 30 ? '...' : ''}</span>`;
      } else if (rule.action === 'edit_attribute' && rule.value !== undefined) {
        const escaped = escapeHTML(`${rule.attribute}="${rule.value}"`);
        previewValHtml = `<span class="rule-preview-val" title="${escaped}">${escaped.substring(0, 30)}${escaped.length > 30 ? '...' : ''}</span>`;
      }

      card.innerHTML = `
        <div class="rule-card-header">
          <span class="rule-selector" title="${escapeHTML(rule.selector)}">${escapeHTML(rule.selector)}</span>
          <div class="rule-controls">
            <label class="switch" title="Включить/выключить это правило">
              <input type="checkbox" class="rule-toggle" data-id="${rule.id}" ${rule.active !== false ? 'checked' : ''}>
              <span class="slider round"></span>
            </label>
            <button class="btn-icon btn-icon-danger rule-delete" data-id="${rule.id}" title="Удалить правило">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>
        </div>
        <div class="rule-card-body">
          <span class="rule-action-badge ${badgeClass}">${badgeText}</span>
          ${previewValHtml}
        </div>
      `;

      // Listeners for rule state modification
      card.querySelector('.rule-toggle').onchange = (e) => {
        rule.active = e.target.checked;
        saveAndSyncRules();
      };

      card.querySelector('.rule-delete').onclick = () => {
        activeDomainData.htmlRules = activeDomainData.htmlRules.filter(r => r.id !== rule.id);
        saveAndSyncRules();
      };

      container.appendChild(card);
    });
  }

  // Save rules to storage and notify content script
  function saveAndSyncRules() {
    chrome.storage.local.get(['siteTweaks'], (result) => {
      const allTweaks = result.siteTweaks || {};
      allTweaks[storageKey] = {
        ...allTweaks[storageKey],
        htmlRules: activeDomainData.htmlRules
      };
      chrome.storage.local.set({ siteTweaks: allTweaks }, () => {
        chrome.tabs.sendMessage(activeTab.id, { action: 'APPLY_HTML_RULES', htmlRules: activeDomainData.htmlRules }, () => {
          showStatus('Правила обновлены!', 'online');
          renderHTMLRulesList();
          renderSitesList();
        });
      });
    });
  }

  // Manual rule creation logic
  function setupManualRuleForm() {
    const btnAddManual = document.getElementById('btn-add-manual-rule');
    const form = document.getElementById('manual-rule-form');
    const btnCancel = document.getElementById('btn-cancel-manual-rule');
    const btnSave = document.getElementById('btn-save-manual-rule');
    
    const inputSelector = document.getElementById('manual-selector');
    const selectAction = document.getElementById('manual-action');
    const valueGroup = document.getElementById('manual-value-group');
    const textareaValue = document.getElementById('manual-value');

    // Trigger input adjustments based on action selection
    selectAction.onchange = () => {
      if (selectAction.value === 'edit_html') {
        valueGroup.style.display = 'block';
      } else {
        valueGroup.style.display = 'none';
      }
    };

    btnAddManual.onclick = () => {
      form.style.display = 'flex';
      btnAddManual.style.display = 'none';
      inputSelector.focus();
    };

    btnCancel.onclick = () => {
      resetForm();
    };

    btnSave.onclick = () => {
      const selector = inputSelector.value.trim();
      const action = selectAction.value;
      const val = textareaValue.value;

      if (!selector) {
        alert('Пожалуйста, введите CSS селектор.');
        inputSelector.focus();
        return;
      }

      // Check selector validity safely
      try {
        document.createDocumentFragment().querySelector(selector);
      } catch (e) {
        alert('Неверный синтаксис CSS селектора.');
        inputSelector.focus();
        return;
      }

      const rule = {
        id: 'rule_' + Date.now(),
        selector: selector,
        action: action,
        value: action === 'edit_html' ? val : '',
        active: true
      };

      if (!activeDomainData.htmlRules) {
        activeDomainData.htmlRules = [];
      }
      activeDomainData.htmlRules.push(rule);
      
      saveAndSyncRules();
      resetForm();
    };

    function resetForm() {
      form.style.display = 'none';
      btnAddManual.style.display = 'block';
      inputSelector.value = '';
      selectAction.value = 'hide';
      valueGroup.style.display = 'none';
      textareaValue.value = '';
    }
  }

  // Backup and restore settings
  function setupBackupControls() {
    const btnExport = document.getElementById('btn-export-json');
    const btnImport = document.getElementById('btn-import-json');
    const importInput = document.getElementById('import-file-input');
    const btnResetAll = document.getElementById('btn-reset-all');

    btnExport.onclick = () => {
      chrome.storage.local.get(['siteTweaks'], (result) => {
        const dataStr = JSON.stringify(result.siteTweaks || {}, null, 2);
        const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
        
        const link = document.createElement('a');
        link.setAttribute('href', dataUri);
        link.setAttribute('download', 'site_tweaker_pro_backup.json');
        link.click();
        showStatus('Резервная копия скачана', 'online');
      });
    };

    btnImport.onclick = () => {
      importInput.click();
    };

    importInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const parsed = JSON.parse(event.target.result);
          if (typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Файл резервной копии поврежден.');
          }

          // Basic validation
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value !== 'object') {
              throw new Error('Неверная структура данных.');
            }
          }

          if (confirm('Импорт перезапишет все настройки в расширении. Продолжить?')) {
            chrome.storage.local.set({ siteTweaks: parsed }, () => {
              showStatus('Данные восстановлены!', 'online');
              initPopup();
              if (activeTab) {
                chrome.tabs.sendMessage(activeTab.id, { action: 'RELOAD_STORAGE' }).catch(() => {});
              }
            });
          }
        } catch (err) {
          alert('Ошибка при импорте JSON: ' + err.message);
        }
      };
      reader.readAsText(file);
      importInput.value = ''; // Reset file input
    };

    btnResetAll.onclick = () => {
      if (confirm('ВНИМАНИЕ! Это действие удалит настройки ВСЕХ сайтов без возможности восстановления. Вы уверены?')) {
        chrome.storage.local.clear(() => {
          chrome.storage.local.set({ siteTweaks: {}, globalEnabled: true }, () => {
            showStatus('Настройки сброшены', 'online');
            
            // Re-init current view elements
            activeDomainData = { css: '', htmlRules: [], enabled: true };
            const cssEditor = document.getElementById('css-editor');
            if (cssEditor) {
              cssEditor.value = '';
              if (cssEditor.oninput) cssEditor.oninput();
            }
            
            const domainToggle = document.getElementById('domain-enable-toggle');
            if (domainToggle) domainToggle.checked = true;
            
            renderHTMLRulesList();
            renderSitesList();

            if (activeTab) {
              chrome.tabs.sendMessage(activeTab.id, { action: 'RELOAD_STORAGE' }).catch(() => {});
            }
          });
        });
      }
    };
  }

  // Render configured websites list
  function renderSitesList() {
    const list = document.getElementById('sites-list');
    if (!list) return;

    chrome.storage.local.get(['siteTweaks'], (result) => {
      const allTweaks = result.siteTweaks || {};
      const hostnames = Object.keys(allTweaks).filter(host => {
        const data = allTweaks[host];
        return (data.css && data.css.trim().length > 0) || (data.htmlRules && data.htmlRules.length > 0);
      });

      if (hostnames.length === 0) {
        list.innerHTML = `
          <div class="empty-state" style="padding: 16px 0;">
            <p>Пока нет других сайтов с изменениями</p>
          </div>
        `;
        return;
      }

      list.innerHTML = '';

      hostnames.forEach((host) => {
        const data = allTweaks[host];
        const cssCount = (data.css && data.css.trim()) ? 1 : 0;
        const htmlCount = data.htmlRules ? data.htmlRules.length : 0;
        const total = cssCount + htmlCount;

        const row = document.createElement('div');
        row.className = 'site-item';
        row.innerHTML = `
          <div class="site-item-info">
            <div class="site-item-name" title="${escapeHTML(host)}">${escapeHTML(host)}</div>
            <div class="site-item-rules-count">Правил: ${total} (CSS: ${cssCount}, HTML: ${htmlCount})</div>
          </div>
          <button class="btn-icon btn-icon-danger delete-site" data-host="${host}" title="Сбросить этот сайт">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        `;

        row.querySelector('.delete-site').onclick = (e) => {
          const targetHost = e.currentTarget.getAttribute('data-host');
          if (confirm(`Удалить все изменения для сайта ${targetHost}?`)) {
            chrome.storage.local.get(['siteTweaks'], (res) => {
              const tweaks = res.siteTweaks || {};
              delete tweaks[targetHost];
              chrome.storage.local.set({ siteTweaks: tweaks }, () => {
                showStatus(`Сайт ${targetHost} сброшен`, 'online');
                
                // If currently open page is deleted
                if (targetHost === activeHostname) {
                  activeDomainData = { css: '', htmlRules: [], enabled: true };
                  const cssEditor = document.getElementById('css-editor');
                  if (cssEditor) cssEditor.value = '';
                  const domainToggle = document.getElementById('domain-enable-toggle');
                  if (domainToggle) domainToggle.checked = true;
                  renderHTMLRulesList();
                  if (activeTab) {
                    chrome.tabs.sendMessage(activeTab.id, { action: 'RELOAD_STORAGE' }).catch(() => {});
                  }
                }
                
                renderSitesList();
              });
            });
          }
        };

        list.appendChild(row);
      });
    });
  }

  // Handle system/unsupported pages gracefully
  function showErrorState(msg) {
    const domainLabel = document.getElementById('current-domain');
    if (domainLabel) {
      domainLabel.textContent = msg;
      domainLabel.style.color = '#ef4444';
    }

    const domainToggle = document.getElementById('domain-enable-toggle');
    if (domainToggle) {
      domainToggle.checked = false;
      domainToggle.disabled = true;
    }

    const cssEditor = document.getElementById('css-editor');
    if (cssEditor) {
      cssEditor.value = '';
      cssEditor.disabled = true;
      cssEditor.placeholder = 'Сайт не поддерживается или расширение не может получить к нему доступ.';
    }

    // Disable action buttons
    const btns = [
      'btn-save-css', 'btn-format-css', 'btn-clear-css', 'btn-insert-img-css',
      'btn-toggle-inspector', 'btn-add-manual-rule', 'btn-reset-domain'
    ];
    btns.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });

    const list = document.getElementById('html-rules-list');
    if (list) {
      list.innerHTML = `
        <div class="empty-state">
          <p>Невозможно изменить дизайн этой страницы.</p>
        </div>
      `;
    }

    showStatus(msg, 'offline');
  }

  // Display status indicator info in footer
  function showStatus(text, type = 'online') {
    const statusTextEl = document.getElementById('status-text');
    const statusIndicatorEl = document.getElementById('status-indicator');
    
    if (!statusTextEl || !statusIndicatorEl) return;
    
    statusTextEl.textContent = text;
    statusIndicatorEl.className = 'status-indicator ' + type;
    
    // Auto return to status online after 3.5s
    if (type !== 'online' && type !== 'working') {
      setTimeout(() => {
        statusTextEl.textContent = 'Изменения автоматически сохраняются';
        statusIndicatorEl.className = 'status-indicator online';
      }, 3500);
    }
  }

  // JS Console controller setup
  function setupConsole() {
    const consoleOutput = document.getElementById('console-output');
    const consoleInput = document.getElementById('console-input');
    const btnRunConsole = document.getElementById('btn-run-console');
    const btnClearConsole = document.getElementById('btn-clear-console');
    
    if (!consoleInput || !btnRunConsole || !consoleOutput) return;

    let consoleHistory = [];
    let historyIndex = -1;

    // Load history from storage
    chrome.storage.local.get(['consoleHistory'], (res) => {
      if (res.consoleHistory) {
        consoleHistory = res.consoleHistory;
      }
    });

    const addConsoleLine = (msg, type = 'log', tag = '') => {
      const line = document.createElement('div');
      line.className = `console-line ${type}`;
      
      const tagSpan = document.createElement('span');
      tagSpan.className = 'console-tag';
      tagSpan.textContent = tag || (type === 'log' ? '[Log]' : type === 'warn' ? '[Warn]' : type === 'error' ? '[Error]' : type === 'result' ? '[Result]' : '[System]');
      
      const msgSpan = document.createElement('span');
      msgSpan.className = 'console-msg';
      msgSpan.textContent = msg;
      
      line.appendChild(tagSpan);
      line.appendChild(msgSpan);
      consoleOutput.appendChild(line);
      consoleOutput.scrollTop = consoleOutput.scrollHeight;
    };

    const runCode = () => {
      const code = consoleInput.value.trim();
      if (!code) return;

      // Add to log
      addConsoleLine(code, 'system', '> ');

      // Add to history
      if (consoleHistory.length === 0 || consoleHistory[consoleHistory.length - 1] !== code) {
        consoleHistory.push(code);
        if (consoleHistory.length > 50) consoleHistory.shift();
        chrome.storage.local.set({ consoleHistory });
      }
      historyIndex = -1;
      consoleInput.value = '';

      if (!activeTab || !activeTab.id) {
        addConsoleLine('Нет активной вкладки.', 'error');
        return;
      }

      chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        world: 'MAIN',
        func: (codeString) => {
          const logs = [];
          const wrapLog = (type) => {
            const original = console[type];
            console[type] = (...args) => {
              logs.push({
                type: type,
                text: args.map(arg => {
                  if (arg === null) return 'null';
                  if (arg === undefined) return 'undefined';
                  if (typeof arg === 'object') {
                    try { return JSON.stringify(arg); } catch(e) { return String(arg); }
                  }
                  return String(arg);
                }).join(' ')
              });
              original.apply(console, args);
            };
            return original;
          };

          const origLog = wrapLog('log');
          const origWarn = wrapLog('warn');
          const origError = wrapLog('error');

          let result;
          let success = true;
          let errorMsg = '';

          try {
            result = eval(codeString);
          } catch (e) {
            success = false;
            errorMsg = e.message;
          }

          console.log = origLog;
          console.warn = origWarn;
          console.error = origError;

          let resultStr = 'undefined';
          if (result !== undefined) {
            try {
              resultStr = typeof result === 'object' ? JSON.stringify(result) : String(result);
            } catch(e) {
              resultStr = String(result);
            }
          }

          return {
            success,
            result: resultStr,
            error: errorMsg,
            logs
          };
        },
        args: [code]
      }).then((results) => {
        if (!results || !results[0]) {
          addConsoleLine('Не удалось получить результат выполнения.', 'error');
          return;
        }

        const res = results[0].result;
        if (res.logs && Array.isArray(res.logs)) {
          res.logs.forEach(l => {
            addConsoleLine(l.text, l.type);
          });
        }

        if (res.success) {
          addConsoleLine(res.result !== undefined ? res.result : 'undefined', 'result', '<- ');
        } else {
          addConsoleLine(res.error || 'Неизвестная ошибка', 'error', '<- Error: ');
        }
      }).catch((err) => {
        addConsoleLine('Ошибка выполнения: ' + err.message, 'error');
      });
    };

    btnRunConsole.onclick = runCode;

    consoleInput.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
        e.preventDefault();
        runCode();
      } else if (e.key === 'ArrowUp' && consoleInput.selectionStart === 0) {
        // Command history UP
        if (consoleHistory.length > 0) {
          if (historyIndex === -1) {
            historyIndex = consoleHistory.length - 1;
          } else {
            historyIndex = Math.max(0, historyIndex - 1);
          }
          consoleInput.value = consoleHistory[historyIndex];
          e.preventDefault();
        }
      } else if (e.key === 'ArrowDown' && consoleInput.selectionStart === consoleInput.value.length) {
        // Command history DOWN
        if (historyIndex !== -1) {
          if (historyIndex === consoleHistory.length - 1) {
            historyIndex = -1;
            consoleInput.value = '';
          } else {
            historyIndex++;
            consoleInput.value = consoleHistory[historyIndex];
          }
          e.preventDefault();
        }
      }
    };

    btnClearConsole.onclick = () => {
      consoleOutput.innerHTML = '';
      addConsoleLine('Логи очищены.', 'system');
    };
  }

  // DOM elements search controller setup
  function setupDOMSearch() {
    const searchInput = document.getElementById('inspector-search-input');
    const btnSearch = document.getElementById('btn-search-elements');
    const resultsList = document.getElementById('search-results-list');

    if (!searchInput || !btnSearch || !resultsList) return;

    const performSearch = () => {
      const query = searchInput.value.trim();
      if (!query) {
        resultsList.style.display = 'none';
        return;
      }

      showStatus('Поиск элементов...', 'working');
      
      if (!activeTab || !activeTab.id) {
        showStatus('Ошибка вкладки', 'offline');
        return;
      }

      chrome.tabs.sendMessage(activeTab.id, { action: 'SEARCH_ELEMENTS', query }, (res) => {
        if (chrome.runtime.lastError || !res) {
          showStatus('Ошибка поиска', 'offline');
          resultsList.innerHTML = `<div class="empty-state" style="padding: 10px 0;"><p>Ошибка связи со страницей.</p></div>`;
          resultsList.style.display = 'block';
          return;
        }

        resultsList.innerHTML = '';
        if (!res.elements || res.elements.length === 0) {
          showStatus('Ничего не найдено', 'online');
          resultsList.innerHTML = `<div class="empty-state" style="padding: 10px 0;"><p>Совпадений не найдено.</p></div>`;
          resultsList.style.display = 'block';
          return;
        }

        showStatus(`Найдено элементов: ${res.elements.length}`, 'online');
        resultsList.style.display = 'block';

        res.elements.forEach(el => {
          const item = document.createElement('div');
          item.className = 'search-result-item';

          item.innerHTML = `
            <div class="search-result-info">
              <span class="search-result-tag" title="${escapeHTML(el.selector)}">${escapeHTML(el.selector)}</span>
              <span class="search-result-text" title="${escapeHTML(el.textPreview)}">${escapeHTML(el.textPreview || '<пустой элемент>')}</span>
            </div>
            <div class="search-result-actions">
              <button class="btn-icon btn-highlight" title="Подсветить на странице">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="8" x2="12" y2="12"></line>
                  <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
              </button>
              <button class="btn-icon btn-edit-specific" title="Изменить в инспекторе" style="color: var(--success); border-color: rgba(16, 185, 129, 0.2);">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 20h9"></path>
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                </svg>
              </button>
              <button class="btn-icon btn-icon-danger btn-hide-specific" title="Скрыть элемент">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
                  <line x1="1" y1="1" x2="23" y2="23"></line>
                </svg>
              </button>
            </div>
          `;

          // Highlight bindings
          const highlightBtn = item.querySelector('.btn-highlight');
          highlightBtn.onclick = () => {
            chrome.tabs.sendMessage(activeTab.id, { action: 'HIGHLIGHT_SPECIFIC_ELEMENT', selector: el.selector });
          };
          item.onmouseenter = () => {
            chrome.tabs.sendMessage(activeTab.id, { action: 'HIGHLIGHT_SPECIFIC_ELEMENT', selector: el.selector, state: true });
          };
          item.onmouseleave = () => {
            chrome.tabs.sendMessage(activeTab.id, { action: 'HIGHLIGHT_SPECIFIC_ELEMENT', selector: el.selector, state: false });
          };

          // Edit Specific binding
          item.querySelector('.btn-edit-specific').onclick = () => {
            chrome.tabs.sendMessage(activeTab.id, { action: 'INSPECT_SPECIFIC_ELEMENT', selector: el.selector }, () => {
              window.close(); // Close popup so user can interact on screen
            });
          };

          // Hide Specific binding
          item.querySelector('.btn-hide-specific').onclick = () => {
            chrome.tabs.sendMessage(activeTab.id, { action: 'HIDE_SPECIFIC_ELEMENT', selector: el.selector }, () => {
              showStatus('Элемент скрыт!', 'online');
              // Reload rules list locally
              chrome.storage.local.get(['siteTweaks'], (storageResult) => {
                const allTweaks = storageResult.siteTweaks || {};
                const activeData = allTweaks[storageKey] || { css: '', htmlRules: [], enabled: true };
                activeDomainData.htmlRules = activeData.htmlRules || [];
                renderHTMLRulesList();
              });
            });
          };

          resultsList.appendChild(item);
        });
      });
    };

    btnSearch.onclick = performSearch;
    searchInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        performSearch();
      }
    };
  }

  // HTML escaping helper
  function escapeHTML(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[&<>"']/g, (m) => {
      switch (m) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#039;';
        default: return m;
      }
    });
  }

})();
