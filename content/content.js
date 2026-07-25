/**
 * DesignGhost - Content Script
 * Automatically applies saved CSS & HTML tweaks, and provides an element inspector.
 */

(function () {
  'use strict';

  if (window.__designGhostLoaded) {
    console.log('DesignGhost: Content script already loaded on this page.');
    return;
  }
  window.__designGhostLoaded = true;

  const hostname = window.location.hostname;

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

  let customStyleElement = null;
  let isInspectMode = false;
  let highlightedElement = null;
  let selectedElement = null;
  let highlightBox = null;
  let highlightTag = null;
  let inspectorModal = null;
  let currentDomainTweaks = { css: '', htmlRules: [], enabled: true };
  let activeDomainTweaks = { css: '', htmlRules: [], enabled: true };
  let activePageTweaks = { css: '', htmlRules: [], enabled: true };
  let cachedSiteTweaks = null;
  let cachedGlobalEnabled = true;
  let cachedActiveScopes = {};
  let mutationObserver = null;
  let copiedStyles = null;
  let mutationTimeout = null;

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

  // Initial Execution
  init();

  function init() {
    createStyleTag();
    loadAndApplyTweaks();
    setupMessageListeners();
    setupMutationObserver();

    // Watch for URL updates in SPAs to reload and apply correct page-specific overrides
    let lastUrl = window.location.href;
    setInterval(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        loadAndApplyTweaks();
      }
    }, 500);
  }

  // 1. Create or get Custom Style Tag in DOM
  function createStyleTag() {
    if (!customStyleElement) {
      customStyleElement = document.createElement('style');
      customStyleElement.id = 'site-tweaker-custom-css';
      const target = document.head || document.documentElement;
      if (target) {
        target.appendChild(customStyleElement);
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          (document.head || document.documentElement).appendChild(customStyleElement);
        });
      }
    }
  }

  let activeScope = 'domain';

  // Revert all previously applied HTML and style rules to restore DOM state
  function revertAllAppliedRules() {
    // 1. Restore HTML
    document.querySelectorAll('[data-stp-original-html]').forEach(el => {
      el.innerHTML = el.getAttribute('data-stp-original-html');
      el.removeAttribute('data-stp-original-html');
      el.removeAttribute('data-stp-modified-html');
    });

    // 2. Restore Text
    document.querySelectorAll('[data-stp-modified-text]').forEach(el => {
      if (el.hasAttribute('data-stp-original-text')) {
        el.textContent = el.getAttribute('data-stp-original-text');
        el.removeAttribute('data-stp-original-text');
      }
      el.removeAttribute('data-stp-modified-text');
    });

    // 3. Restore style and attributes
    document.querySelectorAll('*').forEach(el => {
      // Restore attributes from data-stp-original-*
      Array.from(el.attributes).forEach(attr => {
        if (attr.name.startsWith('data-stp-original-')) {
          const originalAttr = attr.name.replace('data-stp-original-', '');
          const originalValue = attr.value;
          if (originalValue === '') {
            el.removeAttribute(originalAttr);
          } else {
            el.setAttribute(originalAttr, originalValue);
          }
          el.removeAttribute(attr.name);
        }
      });

      // Restore style
      if (el.hasAttribute('data-stp-original-style')) {
        const origStyle = el.getAttribute('data-stp-original-style');
        if (origStyle) {
          el.setAttribute('style', origStyle);
        } else {
          el.removeAttribute('style');
        }
        el.removeAttribute('data-stp-original-style');
      }

      // Restore visibility
      if (el.style.display === 'none') {
        el.style.removeProperty('display');
      }
    });
  }

  // Apply tweaks from cached data synchronously
  function applyCachedTweaks() {
    const globalEnabled = cachedGlobalEnabled !== false;
    const allTweaks = cachedSiteTweaks || {};
    const activeScopes = cachedActiveScopes || {};

    activeScope = activeScopes[hostname] || 'page';

    const domainData = allTweaks[hostname] || { css: '', js: '', html: '', htmlRules: [], enabled: true };
    const pageData = allTweaks[normalizeUrl(window.location.href)] || { css: '', js: '', html: '', htmlRules: [], enabled: true };

    activeDomainTweaks = domainData;
    activePageTweaks = pageData;

    // currentDomainTweaks represents the settings of the ACTIVE scope (either page or domain)
    currentDomainTweaks = (activeScope === 'page') ? pageData : domainData;

    if (globalEnabled) {
      let mergedCss = '';
      let mergedHtmlRules = [];
      let mergedHtml = '';
      let mergedJs = '';

      if (domainData.enabled !== false) {
        mergedCss += (domainData.css || '');
        mergedHtmlRules = mergedHtmlRules.concat(domainData.htmlRules || []);
        mergedHtml += (domainData.html || '');
        mergedJs += (domainData.js || '');
      }

      if (activeScope === 'page' && pageData.enabled !== false) {
        mergedCss += '\n' + (pageData.css || '');
        const pageRules = pageData.htmlRules || [];
        pageRules.forEach(pRule => {
          const idx = mergedHtmlRules.findIndex(dRule => dRule.selector === pRule.selector && dRule.action === pRule.action);
          if (idx >= 0) {
            mergedHtmlRules[idx] = pRule;
          } else {
            mergedHtmlRules.push(pRule);
          }
        });

        if (pageData.html) {
          mergedHtml = pageData.html;
        }
        if (pageData.js) {
          mergedJs += '\n' + pageData.js;
        }
      }

      applyCustomCSS(mergedCss);
      applyHTMLRules(mergedHtmlRules);
      applyCustomHTML(mergedHtml);
      applyCustomJS(mergedJs);
    } else {
      applyCustomCSS('');
      applyCustomHTML('');
      applyCustomJS('');
    }

    updateBadgeCount();
  }

  // 2. Load tweaks from storage for current domain & URL
  function loadAndApplyTweaks(forceReloadFromStorage = false) {
    revertAllAppliedRules();

    // Synchronously clear active CSS and tweaks in memory to prevent race conditions (stale rules applying during SPA render)
    if (customStyleElement) {
      customStyleElement.textContent = '';
    }
    currentDomainTweaks = { css: '', htmlRules: [], enabled: true };

    if (cachedSiteTweaks !== null && !forceReloadFromStorage) {
      applyCachedTweaks();
    } else {
      chrome.storage.local.get(['siteTweaks', 'globalEnabled', 'activeScopes'], (result) => {
        cachedSiteTweaks = result.siteTweaks || {};
        cachedGlobalEnabled = result.globalEnabled !== false;
        cachedActiveScopes = result.activeScopes || {};
        applyCachedTweaks();
      });
    }
  }

  function updateBadgeCount() {
    if (!currentDomainTweaks) return;
    const activeRulesCount = (currentDomainTweaks.css ? 1 : 0) +
      (currentDomainTweaks.html ? 1 : 0) +
      (currentDomainTweaks.js ? 1 : 0) +
      (currentDomainTweaks.htmlRules ? currentDomainTweaks.htmlRules.filter(r => r.active !== false).length : 0);
    chrome.runtime.sendMessage({ action: 'UPDATE_BADGE', count: activeRulesCount }).catch(() => { });
  }

  // 3. Inject CSS into live page
  function applyCustomCSS(cssCode) {
    createStyleTag();
    if (customStyleElement) {
      customStyleElement.textContent = cssCode || '';
    }
  }

  // Inject HTML into custom container in document body
  function applyCustomHTML(htmlCode) {
    let container = document.getElementById('site-tweaker-custom-html-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'site-tweaker-custom-html-container';

      const insertContainer = () => {
        const target = document.body || document.documentElement;
        if (target && !document.getElementById('site-tweaker-custom-html-container')) {
          target.appendChild(container);
        }
      };

      if (document.body) {
        insertContainer();
      } else {
        document.addEventListener('DOMContentLoaded', insertContainer);
      }
    }

    // Avoid resetting innerHTML unnecessarily to avoid page churn
    if (container.innerHTML !== (htmlCode || '')) {
      container.innerHTML = htmlCode || '';
    }
  }

  // Inject script in main world context to run custom JS
  function applyCustomJS(jsCode) {
    const oldScript = document.getElementById('design-ghost-custom-js');
    if (oldScript) oldScript.remove();

    if (!jsCode || !jsCode.trim()) return;

    const script = document.createElement('script');
    script.id = 'design-ghost-custom-js';
    script.textContent = `
      (function() {
        try {
          ${jsCode}
        } catch(e) {
          console.error("DesignGhost Custom JS Error:", e);
        }
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
  }

  // 4. Apply HTML rules to DOM elements
  function applyHTMLRules(rules) {
    if (!rules || !Array.isArray(rules)) return;

    rules.forEach((rule) => {
      if (rule.active === false) return;
      if (!rule.selector) return;

      try {
        const elements = document.querySelectorAll(rule.selector);
        elements.forEach((el) => {
          // Avoid mutating our own inspector elements
          if (el.closest('#site-tweaker-inspector-modal') || el.classList.contains('site-tweaker-highlight-box')) {
            return;
          }

          if (rule.action === 'hide') {
            el.style.setProperty('display', 'none', 'important');
          } else if (rule.action === 'remove') {
            el.remove();
          } else if (rule.action === 'edit_html' && rule.value !== undefined) {
            if (el.getAttribute('data-stp-modified-html') !== rule.id) {
              // Store original html if not stored yet
              if (!el.hasAttribute('data-stp-original-html')) {
                el.setAttribute('data-stp-original-html', el.innerHTML);
              }
              el.innerHTML = rule.value;
              el.setAttribute('data-stp-modified-html', rule.id);
            }
          } else if (rule.action === 'edit_text' && rule.value !== undefined) {
            if (el.getAttribute('data-stp-modified-text') !== rule.id) {
              if (!el.hasAttribute('data-stp-original-text')) {
                el.setAttribute('data-stp-original-text', el.textContent || '');
              }
              el.textContent = rule.value;
              el.setAttribute('data-stp-modified-text', rule.id);
            }
          } else if (rule.action === 'edit_style' && typeof rule.value === 'object') {
            if (!el.hasAttribute('data-stp-original-style')) {
              el.setAttribute('data-stp-original-style', el.getAttribute('style') || '');
            }
            for (const [prop, val] of Object.entries(rule.value)) {
              if (val !== undefined && val !== '') {
                el.style.setProperty(prop, val, 'important');
              }
            }
          } else if (rule.action === 'edit_attribute' && rule.attribute !== undefined && rule.value !== undefined) {
            if (el.getAttribute(rule.attribute) !== rule.value) {
              if (!el.hasAttribute('data-stp-original-' + rule.attribute)) {
                el.setAttribute('data-stp-original-' + rule.attribute, el.getAttribute(rule.attribute) || '');
              }
              el.setAttribute(rule.attribute, rule.value);
            }
          }
        });
      } catch (e) {
        console.warn('DesignGhost: Invalid selector or error applying rule:', rule.selector, e);
      }
    });
  }

  // 5. Mutation Observer to keep dynamic SPA pages modified (debounced for performance)
  function setupMutationObserver() {
    if (mutationObserver) return;

    mutationObserver = new MutationObserver(() => {
      if (mutationTimeout) {
        clearTimeout(mutationTimeout);
      }
      mutationTimeout = setTimeout(() => {
        if (currentDomainTweaks && currentDomainTweaks.htmlRules) {
          applyHTMLRules(currentDomainTweaks.htmlRules);
        }
      }, 50);
    });

    const startObserver = () => {
      if (document.body) {
        mutationObserver.observe(document.body, {
          childList: true,
          subtree: true
        });
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          if (document.body) {
            mutationObserver.observe(document.body, {
              childList: true,
              subtree: true
            });
          }
        });
      }
    };

    startObserver();
  }

  // 6. Listeners for extension messages from popup
  function setupMessageListeners() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'APPLY_CUSTOM_CSS' ||
        message.action === 'APPLY_CUSTOM_JS' ||
        message.action === 'APPLY_CUSTOM_HTML' ||
        message.action === 'APPLY_HTML_RULES') {
        loadAndApplyTweaks(true);
        sendResponse({ success: true });
      }

      if (message.action === 'TOGGLE_INSPECTOR') {
        toggleInspectorMode(message.enable);
        sendResponse({ isInspectMode });
      }

      if (message.action === 'GET_DOM_INFO') {
        sendResponse({
          hostname,
          css: currentDomainTweaks.css || '',
          js: currentDomainTweaks.js || '',
          html: currentDomainTweaks.html || '',
          htmlRules: currentDomainTweaks.htmlRules || [],
          enabled: currentDomainTweaks.enabled !== false,
          isInspectMode
        });
      }

      if (message.action === 'RELOAD_STORAGE') {
        loadAndApplyTweaks(true);
        sendResponse({ success: true });
      }

      if (message.action === 'EXECUTE_CONSOLE_JS') {
        executeConsoleJS(message.code, sendResponse);
        return true; // Keep message channel open for async response
      }

      if (message.action === 'SEARCH_ELEMENTS') {
        sendResponse({ elements: searchElements(message.query) });
      }

      if (message.action === 'HIGHLIGHT_SPECIFIC_ELEMENT') {
        highlightSpecificElement(message.selector, message.state);
        sendResponse({ success: true });
      }

      if (message.action === 'INSPECT_SPECIFIC_ELEMENT') {
        try {
          const el = document.querySelector(message.selector);
          if (el) {
            openInspectorModal(el);
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: 'Элемент не найден' });
          }
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      }

      if (message.action === 'HIDE_SPECIFIC_ELEMENT') {
        try {
          const el = document.querySelector(message.selector);
          if (el) {
            el.style.setProperty('display', 'none', 'important');
            const rule = {
              id: 'rule_' + Date.now(),
              selector: message.selector,
              action: 'hide',
              value: '',
              active: true
            };
            addOrUpdateHTMLRule(rule);
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: 'Элемент не найден' });
          }
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      }

      return true;
    });
  }

  // Save current domain state back to chrome.storage.local
  function saveCurrentDomainTweaks() {
    chrome.storage.local.get(['siteTweaks', 'activeScopes'], (result) => {
      const allTweaks = result.siteTweaks || {};
      const activeScopes = result.activeScopes || {};
      const currentScope = activeScopes[hostname] || 'page';
      const key = (currentScope === 'page') ? normalizeUrl(window.location.href) : hostname;

      allTweaks[key] = currentDomainTweaks;
      chrome.storage.local.set({ siteTweaks: allTweaks }, () => {
        cachedSiteTweaks = allTweaks;
        cachedActiveScopes = activeScopes;
        updateBadgeCount();
        loadAndApplyTweaks();
      });
    });
  }

  // --- 7. Element Inspector & Picker Logic ---

  function toggleInspectorMode(enable) {
    isInspectMode = enable !== undefined ? enable : !isInspectMode;

    if (isInspectMode) {
      createHighlightOverlay();
      document.addEventListener('mouseover', handleMouseOver, true);
      document.addEventListener('click', handleElementClick, true);
      showToast('Режим инспектора активен. Наведите курсор и кликните на нужный элемент.');
    } else {
      removeHighlightOverlay();
      document.removeEventListener('mouseover', handleMouseOver, true);
      document.removeEventListener('click', handleElementClick, true);
      if (inspectorModal) {
        inspectorModal.remove();
        inspectorModal = null;
      }
      showToast('Режим инспектора выключен.');
    }
  }

  function createHighlightOverlay() {
    if (!highlightBox) {
      highlightBox = document.createElement('div');
      highlightBox.className = 'site-tweaker-highlight-box';

      highlightTag = document.createElement('div');
      highlightTag.className = 'site-tweaker-highlight-tag';
      highlightBox.appendChild(highlightTag);

      document.body.appendChild(highlightBox);
    }
  }

  function removeHighlightOverlay() {
    if (highlightBox) {
      highlightBox.remove();
      highlightBox = null;
      highlightTag = null;
    }
  }

  function handleMouseOver(e) {
    if (!isInspectMode) return;
    const target = e.target;

    // Ignore overlay elements
    if (target.closest('#site-tweaker-inspector-modal') || target.classList.contains('site-tweaker-highlight-box')) {
      return;
    }

    highlightedElement = target;
    positionHighlightBox(target);
  }

  function positionHighlightBox(el) {
    if (!highlightBox) return;
    const rect = el.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;

    highlightBox.style.top = `${rect.top + scrollY}px`;
    highlightBox.style.left = `${rect.left + scrollX}px`;
    highlightBox.style.width = `${rect.width}px`;
    highlightBox.style.height = `${rect.height}px`;

    const selector = getUniqueCSSSelector(el);
    highlightTag.textContent = `<${el.tagName.toLowerCase()}> ${selector}`;
  }

  function handleElementClick(e) {
    if (!isInspectMode) return;
    const target = e.target;

    if (target.closest('#site-tweaker-inspector-modal') || target.classList.contains('site-tweaker-highlight-box')) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    selectedElement = target;
    openInspectorModal(target);
  }

  // Generate robust CSS Selector for element
  function getUniqueCSSSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';

    const getClasses = (element) => {
      let classStr = '';
      if (element.classList && element.classList.length > 0) {
        Array.from(element.classList).forEach(cls => {
          if (cls && !cls.startsWith('site-tweaker-') && !cls.startsWith('stp-') && cls !== 'active') {
            classStr += `.${CSS.escape(cls)}`;
          }
        });
      }
      return classStr;
    };

    if (el.id) {
      return `#${CSS.escape(el.id)}${getClasses(el)}`;
    }

    let path = [];
    while (el && el.nodeType === Node.ELEMENT_NODE) {
      let tagName = el.nodeName.toLowerCase();
      let selector = tagName;
      if (el.id) {
        selector += `#${CSS.escape(el.id)}${getClasses(el)}`;
        path.unshift(selector);
        break;
      } else {
        selector += getClasses(el);
        let sibling = el;
        let nth = 1;
        while (sibling = sibling.previousElementSibling) {
          if (sibling.nodeName.toLowerCase() === tagName) nth++;
        }
        if (nth !== 1) selector += `:nth-of-type(${nth})`;
      }
      path.unshift(selector);
      el = el.parentElement;
      if (el && el.tagName === 'BODY') {
        path.unshift('body');
        break;
      }
    }
    return path.join(' > ');
  }

  // RGB to Hex helper functions
  function rgbToHex(rgb) {
    if (!rgb || rgb === 'rgba(0, 0, 0, 0)' || rgb === 'transparent') return '#ffffff';
    const match = rgb.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
    if (!match) {
      const matchRgba = rgb.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d\.]+)\)$/);
      if (matchRgba) {
        if (parseFloat(matchRgba[4]) === 0) return '#ffffff';
        return rgbValuesToHex(parseInt(matchRgba[1]), parseInt(matchRgba[2]), parseInt(matchRgba[3]));
      }
      return '#ffffff';
    }
    return rgbValuesToHex(parseInt(match[1]), parseInt(match[2]), parseInt(match[3]));
  }

  function rgbValuesToHex(r, g, b) {
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
  }

  function getSelectorOptions(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return [];

    const getClasses = (element) => {
      let classes = [];
      if (element.classList && element.classList.length > 0) {
        Array.from(element.classList).forEach(cls => {
          if (cls && !cls.startsWith('site-tweaker-') && !cls.startsWith('stp-') && cls !== 'active') {
            classes.push(cls);
          }
        });
      }
      return classes;
    };

    const options = [];

    if (el.id) {
      options.push(`#${CSS.escape(el.id)}`);
    }

    const tagName = el.nodeName.toLowerCase();
    const classes = getClasses(el);

    if (classes.length > 0) {
      options.push(`${tagName}.${CSS.escape(classes[0])}`);
      options.push(`.${CSS.escape(classes[0])}`);
    }

    const getPath = (useClasses) => {
      let curr = el;
      let path = [];
      while (curr && curr.nodeType === Node.ELEMENT_NODE) {
        let name = curr.nodeName.toLowerCase();
        let selector = name;
        if (curr.id) {
          selector += `#${CSS.escape(curr.id)}`;
          if (useClasses) {
            const clsList = getClasses(curr).map(c => `.${CSS.escape(c)}`).join('');
            selector += clsList;
          }
          path.unshift(selector);
          break;
        } else {
          if (useClasses) {
            const clsList = getClasses(curr).map(c => `.${CSS.escape(c)}`).join('');
            selector += clsList;
          }
          let sibling = curr;
          let nth = 1;
          while (sibling = sibling.previousElementSibling) {
            if (sibling.nodeName.toLowerCase() === name) nth++;
          }
          if (nth !== 1) selector += `:nth-of-type(${nth})`;
        }
        path.unshift(selector);
        curr = curr.parentElement;
        if (curr && curr.tagName === 'BODY') {
          path.unshift('body');
          break;
        }
      }
      return path.join(' > ');
    };

    options.push(getPath(false));
    options.push(getPath(true));

    return Array.from(new Set(options.filter(Boolean)));
  }

  // Open Inspector Dialog Modal
  function openInspectorModal(el) {
    if (inspectorModal) {
      inspectorModal.remove();
    }

    const selectorOptions = getSelectorOptions(el);
    const defaultSelector = getUniqueCSSSelector(el);
    if (!selectorOptions.includes(defaultSelector)) {
      selectorOptions.push(defaultSelector);
    }
    const selector = selectorOptions[0] || defaultSelector;

    const currentHTML = el.innerHTML;
    const isImgTag = el.tagName === 'IMG';

    const matchingRules = [];
    const uniqueMatchingSelectors = new Set();
    if (currentDomainTweaks && currentDomainTweaks.htmlRules) {
      currentDomainTweaks.htmlRules.forEach(rule => {
        try {
          if (el.matches(rule.selector)) {
            matchingRules.push(rule);
            uniqueMatchingSelectors.add(rule.selector);
          }
        } catch (e) { }
      });
    }

    let matchingSelectorsHTML = '';
    selectorOptions.forEach(sel => {
      if (sel === selector) return;
      const isExisting = uniqueMatchingSelectors.has(sel);
      const labelSuffix = isExisting ? ' (Уже добавлено)' : '';
      matchingSelectorsHTML += `<option value="${escapeHTML(sel)}">${escapeHTML(sel)}${labelSuffix}</option>`;
    });

    inspectorModal = document.createElement('div');
    inspectorModal.id = 'site-tweaker-inspector-modal';
    inspectorModal.innerHTML = `
      <div class="stp-header" id="stp-drag-handle">
        <div class="stp-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 10h.01M15 10h.01M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/>
          </svg>
          Инспектор DesignGhost
        </div>
        <button class="stp-close-btn" id="stp-modal-close">&times;</button>
      </div>
      <div class="stp-tabs">
        <button class="stp-tab-btn active" id="stp-tab-btn-style">Стили (CSS)</button>
        <button class="stp-tab-btn" id="stp-tab-btn-html">HTML / Текст</button>
        <button class="stp-tab-btn" id="stp-tab-btn-classes">Классы & Атрибуты</button>
      </div>
      <div class="stp-body">
        <div>
          <div class="stp-label">CSS Селектор</div>
          <select id="stp-selector-choice" class="stp-select" style="font-family: monospace; font-size: 11px; text-align: left; text-align-last: left; width: 100% !important; background-color: #1e293b !important; border: 1px solid rgba(255,255,255,0.15) !important;">
            <option value="${escapeHTML(selector)}">${escapeHTML(selector)}${uniqueMatchingSelectors.has(selector) ? ' (Уже добавлено)' : ' (По умолчанию)'}</option>
            ${matchingSelectorsHTML}
          </select>
        </div>
        <div style="margin-top: 8px; display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.05); padding: 6px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1);">
          <span class="stp-label" style="margin: 0; font-size: 11px;">Область применения:</span>
          <select id="stp-inspector-scope" class="stp-select" style="width: auto; margin: 0; padding: 2px 24px 2px 8px; font-size: 11px; background-color: rgba(30, 41, 59, 0.9); height: 24px; color: #fff;">
            <option value="page">Только на эту страницу</option>
            <option value="domain">На все страницы сайта</option>
          </select>
        </div>

        <!-- TAB 1: VISUAL CSS STYLES -->
        <div class="stp-tab-content active" id="stp-tab-content-style">
          <div class="stp-style-grid">
            <div class="stp-style-col">
              <label class="stp-label">Цвет текста</label>
              <div class="stp-color-input-wrapper">
                <input type="color" id="stp-color-text" class="stp-color-input">
                <input type="text" id="stp-color-text-hex" class="stp-text-input-mini" placeholder="Auto">
                <button class="stp-eyedropper-btn" id="stp-btn-eyedropper-text" title="Выбрать цвет с экрана">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="m2 22 1-1c.6.6 1.4.6 2 0l7-7-2-2-7 7c-.6.6-.6 1.4 0 2l-1 1Zm11-11 7-7c.6-.6.6-1.4 0-2l-2-2c-.6-.6-1.4-.6-2 0l-7 7 4 4Z"/>
                  </svg>
                </button>
              </div>
            </div>
            <div class="stp-style-col">
              <label class="stp-label">Цвет фона</label>
              <div class="stp-color-input-wrapper">
                <input type="color" id="stp-color-bg" class="stp-color-input">
                <input type="text" id="stp-color-bg-hex" class="stp-text-input-mini" placeholder="Auto">
                <button class="stp-eyedropper-btn" id="stp-btn-eyedropper-bg" title="Выбрать цвет с экрана">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="m2 22 1-1c.6.6 1.4.6 2 0l7-7-2-2-7 7c-.6.6-.6 1.4 0 2l-1 1Zm11-11 7-7c.6-.6.6-1.4 0-2l-2-2c-.6-.6-1.4-.6-2 0l-7 7 4 4Z"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>

          <div class="stp-slider-group">
            <div class="stp-slider-header">
              <span class="stp-label">Размер шрифта</span>
              <span class="stp-range-val" id="stp-font-size-val">Auto</span>
            </div>
            <input type="range" id="stp-font-size" min="8" max="72" value="16" class="stp-range-slider">
          </div>

          <div class="stp-slider-group">
            <div class="stp-slider-header">
              <span class="stp-label">Скругление углов</span>
              <span class="stp-range-val" id="stp-border-radius-val">Auto</span>
            </div>
            <input type="range" id="stp-border-radius" min="0" max="60" value="0" class="stp-range-slider">
          </div>

          <div class="stp-slider-group">
            <div class="stp-slider-header">
              <span class="stp-label">Прозрачность</span>
              <span class="stp-range-val" id="stp-opacity-val">100%</span>
            </div>
            <input type="range" id="stp-opacity" min="0" max="100" value="100" class="stp-range-slider">
          </div>

          <div class="stp-style-grid">
            <div class="stp-style-col">
              <label class="stp-label">Внутренний отступ (Padding, px)</label>
              <input type="number" id="stp-padding" class="stp-num-input" placeholder="Auto" min="0">
            </div>
            <div class="stp-style-col">
              <label class="stp-label">Внешний отступ (Margin, px)</label>
              <input type="number" id="stp-margin" class="stp-num-input" placeholder="Auto" min="0">
            </div>
          </div>

          <!-- IMAGE REPLACEMENT (IMG TAG ONLY) -->
          ${isImgTag ? `
          <div class="stp-style-grid" style="margin-top: 6px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 10px;">
            <div class="stp-style-col" style="grid-column: span 2;">
              <label class="stp-label">Замена картинки (src)</label>
              <div class="stp-file-input-wrapper" style="display: flex; gap: 8px;">
                <button class="stp-btn stp-btn-secondary stp-btn-sm" id="stp-btn-upload-img-src" style="flex: 1;">Выбрать фото</button>
                <input type="file" id="stp-upload-img-src" accept="image/*" style="display:none;">
                <button class="stp-btn stp-btn-danger" id="stp-btn-revert-img-src" style="display: none; padding: 0 10px;" title="Сбросить картинку">&times;</button>
              </div>
            </div>
          </div>
          <div id="stp-img-options" style="display: none; margin-top: 8px; gap: 8px; flex-direction: column;">
            <div class="stp-style-grid">
              <div class="stp-style-col">
                <label class="stp-label">Размер фото</label>
                <select id="stp-img-fit" class="stp-select">
                  <option value="fill">Растянуть (fill)</option>
                  <option value="cover">Заполнить (cover)</option>
                  <option value="contain">Вписать (contain)</option>
                  <option value="none">Исходный (none)</option>
                </select>
              </div>
              <div class="stp-style-col">
                <label class="stp-label">Положение фото</label>
                <select id="stp-img-position" class="stp-select">
                  <option value="center">Центр</option>
                  <option value="top">Сверху</option>
                  <option value="bottom">Снизу</option>
                  <option value="left">Слева</option>
                  <option value="right">Справа</option>
                </select>
              </div>
            </div>
          </div>
          ` : ''}

          <!-- BACKGROUND IMAGE UPLOADER -->
          <div class="stp-style-grid" style="margin-top: 6px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 10px;">
            <div class="stp-style-col" style="grid-column: span 2;">
              <label class="stp-label">Фоновое изображение</label>
              <div class="stp-file-input-wrapper" style="display: flex; gap: 8px;">
                <button class="stp-btn stp-btn-secondary stp-btn-sm" id="stp-btn-upload-bg-img" style="flex: 1;">Загрузить фон</button>
                <input type="file" id="stp-upload-bg-img" accept="image/*" style="display:none;">
                <button class="stp-btn stp-btn-danger" id="stp-btn-clear-bg-img" style="display: none; padding: 0 10px;" title="Удалить фон">&times;</button>
              </div>
            </div>
          </div>
          <!-- BACKGROUND OPTIONS -->
          <div id="stp-bg-options" style="display: none; margin-top: 8px; gap: 8px; flex-direction: column;">
            <div class="stp-style-grid">
              <div class="stp-style-col">
                <label class="stp-label">Размер фона</label>
                <select id="stp-bg-size" class="stp-select">
                  <option value="cover">Заполнить (cover)</option>
                  <option value="contain">Вписать (contain)</option>
                  <option value="auto">Авто (auto)</option>
                </select>
              </div>
              <div class="stp-style-col">
                <label class="stp-label">Позиция фона</label>
                <select id="stp-bg-position" class="stp-select">
                  <option value="center">Центр</option>
                  <option value="top">Сверху</option>
                  <option value="bottom">Снизу</option>
                  <option value="left">Слева</option>
                  <option value="right">Справа</option>
                  <option value="custom">Вручную (px)</option>
                </select>
              </div>
            </div>
            <div id="stp-bg-custom-position" class="stp-style-grid" style="display: none; margin-top: 4px;">
              <div class="stp-style-col">
                <label class="stp-label">Смещение X (px)</label>
                <input type="number" id="stp-bg-pos-x" class="stp-num-input" placeholder="0">
              </div>
              <div class="stp-style-col">
                <label class="stp-label">Смещение Y (px)</label>
                <input type="number" id="stp-bg-pos-y" class="stp-num-input" placeholder="0">
              </div>
            </div>
            <div class="stp-style-grid" style="margin-top: 4px;">
              <div class="stp-style-col" style="grid-column: span 2;">
                <label class="stp-label">Повторение фона</label>
                <select id="stp-bg-repeat" class="stp-select">
                  <option value="no-repeat">Не повторять</option>
                  <option value="repeat">Повторять</option>
                </select>
              </div>
            </div>
          </div>

          <div class="stp-actions" style="margin-top: 8px;">
            <button class="stp-btn stp-btn-primary" id="stp-save-styles">
              Сохранить стили
            </button>
            <button class="stp-btn stp-btn-warning" id="stp-reset-element-styles">
              Сбросить стили
            </button>
          </div>
        </div>

        <!-- TAB 2: HTML EDIT -->
        <div class="stp-tab-content" id="stp-tab-content-html">
          <div>
            <div class="stp-label" style="display: flex; justify-content: space-between; align-items: center;">
              <span>HTML код элемента</span>
              <button class="stp-btn stp-btn-secondary stp-btn-xs" id="stp-btn-insert-img-html" style="width: auto;">
                Вставить фото
              </button>
              <input type="file" id="stp-insert-img-html" accept="image/*" style="display:none;">
            </div>
            <textarea class="stp-textarea" id="stp-html-input" spellcheck="false" style="height: 220px;"></textarea>
          </div>

          <div class="stp-actions" style="margin-top: 6px;">
            <button class="stp-btn stp-btn-primary" id="stp-save-html">
              Применить HTML
            </button>
            <button class="stp-btn stp-btn-secondary" id="stp-revert-html" title="Восстановить исходный HTML">
              Сбросить HTML
            </button>
          </div>
        </div>

        <!-- TAB 3: CLASSES & ATTRIBUTES -->
        <div class="stp-tab-content" id="stp-tab-content-classes">
          <div>
            <div class="stp-label">Классы элемента</div>
            <div class="stp-classes-container" id="stp-classes-container"></div>
            <div class="stp-file-input-wrapper" style="display: flex; gap: 8px; margin-top: 4px;">
              <input type="text" id="stp-input-add-class" class="stp-num-input" style="flex: 1; text-align: left;" placeholder="Имя нового класса...">
              <button class="stp-btn stp-btn-secondary stp-btn-sm" id="stp-btn-add-class" style="width: auto;">Добавить</button>
            </div>
          </div>
          <div class="stp-divider"></div>
          <div>
            <div class="stp-label">Кастомные атрибуты</div>
            <div class="stp-attributes-list" id="stp-attributes-list" style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px;"></div>
            <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 6px;">
              <input type="text" id="stp-input-add-attr-name" class="stp-num-input" style="text-align: left; padding: 6px 10px;" placeholder="Атрибут...">
              <input type="text" id="stp-input-add-attr-val" class="stp-num-input" style="text-align: left; padding: 6px 10px;" placeholder="Значение...">
              <button class="stp-btn stp-btn-secondary stp-btn-sm" id="stp-btn-add-attr" style="width: auto;">+</button>
            </div>
          </div>
        </div>

        <div class="stp-divider"></div>

        <div class="stp-actions">
          <button class="stp-btn stp-btn-warning" id="stp-hide-element" style="background: rgba(245, 158, 11, 0.15) !important;">
            Скрыть
          </button>
          <button class="stp-btn stp-btn-danger" id="stp-remove-element">
            Удалить
          </button>
        </div>

        <div class="stp-actions">
          <button class="stp-btn stp-btn-secondary" id="stp-finish-inspect" style="grid-column: span 2;">
            Готово
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(inspectorModal);
    makeModalDraggable(inspectorModal);

    // Tab switching elements
    const tabStyleBtn = document.getElementById('stp-tab-btn-style');
    const tabHtmlBtn = document.getElementById('stp-tab-btn-html');
    const tabClassesBtn = document.getElementById('stp-tab-btn-classes');

    const tabStyleContent = document.getElementById('stp-tab-content-style');
    const tabHtmlContent = document.getElementById('stp-tab-content-html');
    const tabClassesContent = document.getElementById('stp-tab-content-classes');

    tabStyleBtn.onclick = () => {
      tabStyleBtn.classList.add('active');
      tabHtmlBtn.classList.remove('active');
      tabClassesBtn.classList.remove('active');
      tabStyleContent.classList.add('active');
      tabHtmlContent.classList.remove('active');
      tabClassesContent.classList.remove('active');
    };

    tabHtmlBtn.onclick = () => {
      tabHtmlBtn.classList.add('active');
      tabStyleBtn.classList.remove('active');
      tabClassesBtn.classList.remove('active');
      tabHtmlContent.classList.add('active');
      tabStyleContent.classList.remove('active');
      tabClassesContent.classList.remove('active');
    };

    tabClassesBtn.onclick = () => {
      tabClassesBtn.classList.add('active');
      tabStyleBtn.classList.remove('active');
      tabHtmlBtn.classList.remove('active');
      tabClassesContent.classList.add('active');
      tabStyleContent.classList.remove('active');
      tabHtmlContent.classList.remove('active');
    };

    // Pre-populate visually with computed values
    const computed = window.getComputedStyle(el);
    const textColHex = rgbToHex(computed.color);
    const bgColHex = rgbToHex(computed.backgroundColor);

    const colorText = document.getElementById('stp-color-text');
    const colorTextHex = document.getElementById('stp-color-text-hex');
    const colorBg = document.getElementById('stp-color-bg');
    const colorBgHex = document.getElementById('stp-color-bg-hex');
    const fontSize = document.getElementById('stp-font-size');
    const fontSizeVal = document.getElementById('stp-font-size-val');
    const borderRadius = document.getElementById('stp-border-radius');
    const borderRadiusVal = document.getElementById('stp-border-radius-val');
    const opacity = document.getElementById('stp-opacity');
    const opacityVal = document.getElementById('stp-opacity-val');
    const paddingInput = document.getElementById('stp-padding');
    const marginInput = document.getElementById('stp-margin');

    // Image/Background controls
    const uploadBgImg = document.getElementById('stp-upload-bg-img');
    const btnUploadBgImg = document.getElementById('stp-btn-upload-bg-img');
    const btnClearBgImg = document.getElementById('stp-btn-clear-bg-img');

    colorText.value = textColHex;
    colorTextHex.value = textColHex;
    colorBg.value = bgColHex;
    colorBgHex.value = bgColHex;

    const currentFSize = parseFloat(computed.fontSize);
    fontSize.value = currentFSize;
    fontSizeVal.textContent = currentFSize + 'px';

    const currentBRad = parseFloat(computed.borderRadius) || 0;
    borderRadius.value = currentBRad;
    borderRadiusVal.textContent = currentBRad + 'px';

    const currentOp = Math.round(parseFloat(computed.opacity) * 100) || 100;
    opacity.value = currentOp;
    opacityVal.textContent = currentOp + '%';

    paddingInput.value = parseInt(computed.paddingTop) || '';
    marginInput.value = parseInt(computed.marginTop) || '';

    // Pre-populate custom HTML
    document.getElementById('stp-html-input').value = el.innerHTML;

    let activeSelector = selector;
    const selectorChoice = document.getElementById('stp-selector-choice');

    const loadRuleValues = (selectedSel) => {
      activeSelector = selectedSel;
      const existingStyleRule = matchingRules.find(r => r.selector === selectedSel && r.action === 'edit_style');
      if (existingStyleRule && typeof existingStyleRule.value === 'object') {
        const val = existingStyleRule.value;
        colorText.value = val.color || textColHex;
        colorTextHex.value = val.color || textColHex;
        colorBg.value = val['background-color'] || bgColHex;
        colorBgHex.value = val['background-color'] || bgColHex;
        fontSize.value = parseFloat(val['font-size']) || currentFSize;
        fontSizeVal.textContent = (val['font-size'] || currentFSize + 'px');
        borderRadius.value = parseFloat(val['border-radius']) || currentBRad;
        borderRadiusVal.textContent = (val['border-radius'] || currentBRad + 'px');
        opacity.value = val.opacity !== undefined ? Math.round(parseFloat(val.opacity) * 100) : currentOp;
        opacityVal.textContent = (val.opacity !== undefined ? Math.round(parseFloat(val.opacity) * 100) : currentOp) + '%';
        paddingInput.value = val.padding ? parseInt(val.padding) : '';
        marginInput.value = val.margin ? parseInt(val.margin) : '';
      } else {
        // Reset to computed styles
        colorText.value = textColHex;
        colorTextHex.value = textColHex;
        colorBg.value = bgColHex;
        colorBgHex.value = bgColHex;
        fontSize.value = currentFSize;
        fontSizeVal.textContent = currentFSize + 'px';
        borderRadius.value = currentBRad;
        borderRadiusVal.textContent = currentBRad + 'px';
        opacity.value = currentOp;
        opacityVal.textContent = currentOp + '%';
        paddingInput.value = parseInt(computed.paddingTop) || '';
        marginInput.value = parseInt(computed.marginTop) || '';
      }
    };

    if (selectorChoice) {
      selectorChoice.onchange = (e) => {
        loadRuleValues(e.target.value);
      };
      if (uniqueMatchingSelectors.size > 0) {
        const firstExisting = Array.from(uniqueMatchingSelectors)[0];
        selectorChoice.value = firstExisting;
        loadRuleValues(firstExisting);
      }
    }

    // Background options container and elements
    const bgOptionsContainer = document.getElementById('stp-bg-options');
    const selectBgSize = document.getElementById('stp-bg-size');
    const selectBgPosition = document.getElementById('stp-bg-position');
    const selectBgRepeat = document.getElementById('stp-bg-repeat');

    // Prepopulate background styling values
    if (computed.backgroundImage && computed.backgroundImage !== 'none') {
      btnClearBgImg.style.display = 'block';
      if (bgOptionsContainer) bgOptionsContainer.style.display = 'flex';

      if (selectBgSize) {
        const sz = el.style.backgroundSize || computed.backgroundSize;
        if (['cover', 'contain', 'auto'].includes(sz)) selectBgSize.value = sz;
      }
      if (selectBgPosition) {
        const pos = el.style.backgroundPosition || computed.backgroundPosition;
        if (pos.includes('top')) selectBgPosition.value = 'top';
        else if (pos.includes('bottom')) selectBgPosition.value = 'bottom';
        else if (pos.includes('left')) selectBgPosition.value = 'left';
        else if (pos.includes('right')) selectBgPosition.value = 'right';
        else if (pos.includes('px') || /^-?\d+/.test(pos)) {
          selectBgPosition.value = 'custom';
          const parts = pos.split(' ');
          if (parts[0]) document.getElementById('stp-bg-pos-x').value = parseInt(parts[0]) || 0;
          if (parts[1]) document.getElementById('stp-bg-pos-y').value = parseInt(parts[1]) || 0;
          const customPosBlock = document.getElementById('stp-bg-custom-position');
          if (customPosBlock) customPosBlock.style.display = 'flex';
        }
        else selectBgPosition.value = 'center';
      }
      if (selectBgRepeat) {
        const rep = el.style.backgroundRepeat || computed.backgroundRepeat;
        if (rep.includes('no-repeat')) selectBgRepeat.value = 'no-repeat';
        else if (rep.includes('repeat')) selectBgRepeat.value = 'repeat';
      }
    }

    // Pre-populate tag image styling values
    let selectImgFit = null;
    let selectImgPosition = null;
    if (isImgTag) {
      const imgOptionsContainer = document.getElementById('stp-img-options');
      selectImgFit = document.getElementById('stp-img-fit');
      selectImgPosition = document.getElementById('stp-img-position');

      if (imgOptionsContainer) imgOptionsContainer.style.display = 'flex';
      if (el.hasAttribute('data-stp-original-src')) {
        document.getElementById('stp-btn-revert-img-src').style.display = 'block';
      }

      if (selectImgFit) {
        const fit = el.style.objectFit || computed.objectFit;
        if (['fill', 'cover', 'contain', 'none'].includes(fit)) selectImgFit.value = fit;
      }
      if (selectImgPosition) {
        const pos = el.style.objectPosition || computed.objectPosition;
        if (pos.includes('top')) selectImgPosition.value = 'top';
        else if (pos.includes('bottom')) selectImgPosition.value = 'bottom';
        else if (pos.includes('left')) selectImgPosition.value = 'left';
        else if (pos.includes('right')) selectImgPosition.value = 'right';
        else selectImgPosition.value = 'center';
      }
    }

    // Live update bindings
    colorText.oninput = () => {
      colorTextHex.value = colorText.value;
      applyLiveStyles();
    };
    colorTextHex.oninput = () => {
      if (/^#[0-9A-F]{6}$/i.test(colorTextHex.value)) {
        colorText.value = colorTextHex.value;
        applyLiveStyles();
      }
    };

    colorBg.oninput = () => {
      colorBgHex.value = colorBg.value;
      applyLiveStyles();
    };
    colorBgHex.oninput = () => {
      if (/^#[0-9A-F]{6}$/i.test(colorBgHex.value)) {
        colorBg.value = colorBgHex.value;
        applyLiveStyles();
      }
    };

    // Text color Eyedropper API
    const btnEyedropperText = document.getElementById('stp-btn-eyedropper-text');
    if (btnEyedropperText) {
      if (!window.EyeDropper) {
        btnEyedropperText.style.display = 'none';
      } else {
        btnEyedropperText.onclick = () => {
          const eyeDropper = new EyeDropper();
          eyeDropper.open().then((result) => {
            const hexColor = result.sRGBHex;
            colorText.value = hexColor;
            colorTextHex.value = hexColor.toUpperCase();
            applyLiveStyles();
            showToast('Цвет текста выбран с экрана!');
          }).catch((err) => {
            // Eyedropper cancelled
          });
        };
      }
    }

    // Background color Eyedropper API
    const btnEyedropperBg = document.getElementById('stp-btn-eyedropper-bg');
    if (btnEyedropperBg) {
      if (!window.EyeDropper) {
        btnEyedropperBg.style.display = 'none';
      } else {
        btnEyedropperBg.onclick = () => {
          const eyeDropper = new EyeDropper();
          eyeDropper.open().then((result) => {
            const hexColor = result.sRGBHex;
            colorBg.value = hexColor;
            colorBgHex.value = hexColor.toUpperCase();
            applyLiveStyles();
            showToast('Цвет фона выбран с экрана!');
          }).catch((err) => {
            // Eyedropper cancelled
          });
        };
      }
    }

    fontSize.oninput = () => {
      fontSizeVal.textContent = fontSize.value + 'px';
      applyLiveStyles();
    };

    borderRadius.oninput = () => {
      borderRadiusVal.textContent = borderRadius.value + 'px';
      applyLiveStyles();
    };

    opacity.oninput = () => {
      opacityVal.textContent = opacity.value + '%';
      applyLiveStyles();
    };

    paddingInput.oninput = applyLiveStyles;
    marginInput.oninput = applyLiveStyles;

    function applyLiveStyles() {
      el.style.setProperty('color', colorText.value, 'important');
      el.style.setProperty('background-color', colorBg.value, 'important');
      el.style.setProperty('font-size', fontSize.value + 'px', 'important');
      el.style.setProperty('border-radius', borderRadius.value + 'px', 'important');
      el.style.setProperty('opacity', (opacity.value / 100).toString(), 'important');

      if (paddingInput.value !== '') {
        el.style.setProperty('padding', paddingInput.value + 'px', 'important');
      } else {
        el.style.removeProperty('padding');
      }

      if (marginInput.value !== '') {
        el.style.setProperty('margin', marginInput.value + 'px', 'important');
      } else {
        el.style.removeProperty('margin');
      }

      // Live apply background image helper rules
      const hasBg = el.style.backgroundImage && el.style.backgroundImage !== 'none';
      if (hasBg) {
        if (selectBgSize && selectBgSize.value) {
          el.style.setProperty('background-size', selectBgSize.value, 'important');
        }
        if (selectBgPosition && selectBgPosition.value) {
          if (selectBgPosition.value === 'custom') {
            const posX = document.getElementById('stp-bg-pos-x').value || '0';
            const posY = document.getElementById('stp-bg-pos-y').value || '0';
            el.style.setProperty('background-position', `${posX}px ${posY}px`, 'important');
          } else {
            el.style.setProperty('background-position', selectBgPosition.value, 'important');
          }
        }
        if (selectBgRepeat && selectBgRepeat.value) {
          el.style.setProperty('background-repeat', selectBgRepeat.value, 'important');
        }
      }

      // Live apply photo img object fit helper rules
      if (isImgTag) {
        if (selectImgFit && selectImgFit.value) {
          el.style.setProperty('object-fit', selectImgFit.value, 'important');
        }
        if (selectImgPosition && selectImgPosition.value) {
          el.style.setProperty('object-position', selectImgPosition.value, 'important');
        }
      }
    }

    // Bind dropdown selectors live updates
    if (selectBgSize) selectBgSize.onchange = applyLiveStyles;
    if (selectBgPosition) {
      selectBgPosition.onchange = () => {
        const customBlock = document.getElementById('stp-bg-custom-position');
        if (selectBgPosition.value === 'custom') {
          if (customBlock) customBlock.style.display = 'flex';
        } else {
          if (customBlock) customBlock.style.display = 'none';
        }
        applyLiveStyles();
      };
    }

    const inputBgPosX = document.getElementById('stp-bg-pos-x');
    const inputBgPosY = document.getElementById('stp-bg-pos-y');
    if (inputBgPosX) inputBgPosX.oninput = applyLiveStyles;
    if (inputBgPosY) inputBgPosY.oninput = applyLiveStyles;

    if (selectBgRepeat) selectBgRepeat.onchange = applyLiveStyles;
    if (isImgTag) {
      if (selectImgFit) selectImgFit.onchange = applyLiveStyles;
      if (selectImgPosition) selectImgPosition.onchange = applyLiveStyles;
    }

    // BG Image upload
    btnUploadBgImg.onclick = () => uploadBgImg.click();
    uploadBgImg.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;

      showToast('Сжатие фонового изображения...');
      compressAndResizeImage(file, 1200, 0.8).then((dataUrl) => {
        el.style.setProperty('background-image', `url("${dataUrl}")`, 'important');
        btnClearBgImg.style.display = 'block';
        if (bgOptionsContainer) bgOptionsContainer.style.display = 'flex';
        applyLiveStyles();
        showToast('Фоновое изображение установлено!');
      }).catch((err) => {
        showToast('Ошибка сжатия изображения');
      });
    };

    btnClearBgImg.onclick = () => {
      el.style.removeProperty('background-image');
      el.style.removeProperty('background-size');
      el.style.removeProperty('background-position');
      el.style.removeProperty('background-repeat');
      uploadBgImg.value = '';
      btnClearBgImg.style.display = 'none';
      if (bgOptionsContainer) bgOptionsContainer.style.display = 'none';
      showToast('Фоновое изображение удалено.');
    };

    // IMG Tag Src replacement
    if (isImgTag) {
      const uploadImgSrc = document.getElementById('stp-upload-img-src');
      const btnUploadImgSrc = document.getElementById('stp-btn-upload-img-src');
      const btnRevertImgSrc = document.getElementById('stp-btn-revert-img-src');

      btnUploadImgSrc.onclick = () => uploadImgSrc.click();
      uploadImgSrc.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        showToast('Сжатие изображения...');
        compressAndResizeImage(file, 1200, 0.8).then((dataUrl) => {
          if (!el.hasAttribute('data-stp-original-src')) {
            el.setAttribute('data-stp-original-src', el.getAttribute('src') || '');
          }
          el.src = dataUrl;

          const imgOptionsContainer = document.getElementById('stp-img-options');
          if (imgOptionsContainer) imgOptionsContainer.style.display = 'flex';
          applyLiveStyles();

          const rule = {
            id: 'rule_' + Date.now(),
            selector: activeSelector,
            action: 'edit_attribute',
            attribute: 'src',
            value: dataUrl,
            active: true
          };

          addOrUpdateHTMLRule(rule);
          btnRevertImgSrc.style.display = 'block';
          showToast('Изображение заменено!');
        }).catch((err) => {
          showToast('Ошибка сжатия изображения');
        });
      };

      btnRevertImgSrc.onclick = () => {
        if (el.hasAttribute('data-stp-original-src')) {
          el.src = el.getAttribute('data-stp-original-src');
          el.removeAttribute('data-stp-original-src');
        }

        el.style.removeProperty('object-fit');
        el.style.removeProperty('object-position');
        const imgOptionsContainer = document.getElementById('stp-img-options');
        if (imgOptionsContainer) imgOptionsContainer.style.display = 'none';

        removeHTMLRule(activeSelector, 'edit_attribute', 'src');

        btnRevertImgSrc.style.display = 'none';
        uploadImgSrc.value = '';
        showToast('Изображение сброшено до оригинала.');
      };
    }

    // Insert Image in HTML Editor Textarea
    const insertImgHtml = document.getElementById('stp-insert-img-html');
    const btnInsertImgHtml = document.getElementById('stp-btn-insert-img-html');

    btnInsertImgHtml.onclick = () => insertImgHtml.click();
    insertImgHtml.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;

      showToast('Сжатие изображения...');
      compressAndResizeImage(file, 1200, 0.8).then((dataUrl) => {
        const textarea = document.getElementById('stp-html-input');
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const imgTag = `<img src="${dataUrl}" style="max-width: 100%; height: auto;">`;
        textarea.value = textarea.value.substring(0, start) + imgTag + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + imgTag.length;
        textarea.focus();
        showToast('Изображение вставлено в HTML!');
      }).catch((err) => {
        showToast('Ошибка сжатия изображения');
      });
      insertImgHtml.value = '';
    };

    // Save visual style rule
    document.getElementById('stp-save-styles').onclick = () => {
      const stylesObj = {
        'color': colorText.value,
        'background-color': colorBg.value,
        'font-size': fontSize.value + 'px',
        'border-radius': borderRadius.value + 'px',
        'opacity': (opacity.value / 100).toString()
      };

      if (paddingInput.value !== '') {
        stylesObj['padding'] = paddingInput.value + 'px';
      }
      if (marginInput.value !== '') {
        stylesObj['margin'] = marginInput.value + 'px';
      }

      const bgImg = el.style.backgroundImage;
      if (bgImg && bgImg !== 'none') {
        stylesObj['background-image'] = bgImg;
        if (selectBgSize && selectBgSize.value) {
          stylesObj['background-size'] = selectBgSize.value;
        }
        if (selectBgPosition && selectBgPosition.value) {
          if (selectBgPosition.value === 'custom') {
            const posX = document.getElementById('stp-bg-pos-x').value || '0';
            const posY = document.getElementById('stp-bg-pos-y').value || '0';
            stylesObj['background-position'] = `${posX}px ${posY}px`;
          } else {
            stylesObj['background-position'] = selectBgPosition.value;
          }
        }
        if (selectBgRepeat && selectBgRepeat.value) {
          stylesObj['background-repeat'] = selectBgRepeat.value;
        }
      }

      if (isImgTag) {
        if (selectImgFit && selectImgFit.value) {
          stylesObj['object-fit'] = selectImgFit.value;
        }
        if (selectImgPosition && selectImgPosition.value) {
          stylesObj['object-position'] = selectImgPosition.value;
        }
      }

      const rule = {
        id: 'rule_' + Date.now(),
        selector: activeSelector,
        action: 'edit_style',
        value: stylesObj,
        active: true
      };

      addOrUpdateHTMLRule(rule);
      showToast('Визуальные стили элемента сохранены!');
    };

    // Reset visual styles
    document.getElementById('stp-reset-element-styles').onclick = () => {
      el.style.removeProperty('color');
      el.style.removeProperty('background-color');
      el.style.removeProperty('font-size');
      el.style.removeProperty('border-radius');
      el.style.removeProperty('opacity');
      el.style.removeProperty('padding');
      el.style.removeProperty('margin');
      el.style.removeProperty('background-image');
      el.style.removeProperty('background-size');
      el.style.removeProperty('background-position');
      el.style.removeProperty('background-repeat');
      el.style.removeProperty('object-fit');
      el.style.removeProperty('object-position');

      removeHTMLRule(activeSelector, 'edit_style');

      // Re-populate computed styles
      const currentComputed = window.getComputedStyle(el);
      const hexText = rgbToHex(currentComputed.color);
      const hexBg = rgbToHex(currentComputed.backgroundColor);
      colorText.value = hexText;
      colorTextHex.value = hexText;
      colorBg.value = hexBg;
      colorBgHex.value = hexBg;
      fontSize.value = parseFloat(currentComputed.fontSize);
      fontSizeVal.textContent = currentComputed.fontSize;
      borderRadius.value = parseFloat(currentComputed.borderRadius) || 0;
      borderRadiusVal.textContent = (parseFloat(currentComputed.borderRadius) || 0) + 'px';
      opacity.value = parseFloat(currentComputed.opacity) * 100 || 100;
      opacityVal.textContent = Math.round(parseFloat(currentComputed.opacity) * 100 || 100) + '%';
      paddingInput.value = '';
      marginInput.value = '';
      btnClearBgImg.style.display = 'none';
      if (bgOptionsContainer) bgOptionsContainer.style.display = 'none';
      if (isImgTag) {
        const imgOptionsContainer = document.getElementById('stp-img-options');
        if (imgOptionsContainer) imgOptionsContainer.style.display = 'none';
      }

      showToast('Стили элемента сброшены до исходных.');
    };

    // Event Handlers for close and save
    document.getElementById('stp-modal-close').onclick = () => inspectorModal.remove();
    document.getElementById('stp-finish-inspect').onclick = () => toggleInspectorMode(false);

    // Save HTML Action
    document.getElementById('stp-save-html').onclick = () => {
      const newHTML = document.getElementById('stp-html-input').value;
      if (!el.hasAttribute('data-stp-original-html')) {
        el.setAttribute('data-stp-original-html', el.innerHTML);
      }
      el.innerHTML = newHTML;

      const rule = {
        id: 'rule_' + Date.now(),
        selector: activeSelector,
        action: 'edit_html',
        value: newHTML,
        active: true
      };

      addOrUpdateHTMLRule(rule);
      showToast('HTML код элемента изменен и сохранен!');
    };

    // Revert HTML Action
    document.getElementById('stp-revert-html').onclick = () => {
      if (el.hasAttribute('data-stp-original-html')) {
        el.innerHTML = el.getAttribute('data-stp-original-html');
        el.removeAttribute('data-stp-original-html');
        el.removeAttribute('data-stp-modified-html');
      }

      document.getElementById('stp-html-input').value = el.innerHTML;

      removeHTMLRule(activeSelector, 'edit_html');

      showToast('HTML код элемента сброшен до исходного.');
    };

    // Hide Action
    document.getElementById('stp-hide-element').onclick = () => {
      el.style.setProperty('display', 'none', 'important');

      const rule = {
        id: 'rule_' + Date.now(),
        selector: activeSelector,
        action: 'hide',
        value: '',
        active: true
      };

      addOrUpdateHTMLRule(rule);
      showToast('Элемент успешно скрыт.');
      inspectorModal.remove();
    };

    // Remove Action
    document.getElementById('stp-remove-element').onclick = () => {
      el.remove();

      const rule = {
        id: 'rule_' + Date.now(),
        selector: activeSelector,
        action: 'remove',
        value: '',
        active: true
      };

      addOrUpdateHTMLRule(rule);
      showToast('Элемент успешно удален.');
      inspectorModal.remove();
    };

    // Classes and attributes dynamic inspector logic
    const classesContainer = document.getElementById('stp-classes-container');
    const attributesList = document.getElementById('stp-attributes-list');

    const updateClassesAndAttributesUI = () => {
      if (!classesContainer || !attributesList) return;

      // Render classes
      classesContainer.innerHTML = '';
      if (el.classList.length === 0) {
        classesContainer.innerHTML = '<span style="color: #64748b; font-size: 11px; padding: 4px;">Нет классов</span>';
      } else {
        Array.from(el.classList).forEach(cls => {
          if (cls === 'site-tweaker-highlight-box' || cls === 'site-tweaker-selected-box') return;

          const badge = document.createElement('span');
          badge.className = 'stp-class-badge';
          badge.innerHTML = `
            <span>.${cls}</span>
            <span class="stp-class-badge-remove" data-class="${cls}">&times;</span>
          `;

          badge.querySelector('.stp-class-badge-remove').onclick = (e) => {
            const classToRemove = e.target.getAttribute('data-class');
            el.classList.remove(classToRemove);

            const rule = {
              id: 'rule_' + Date.now(),
              selector: activeSelector,
              action: 'edit_attribute',
              attribute: 'class',
              value: el.className,
              active: true
            };
            addOrUpdateHTMLRule(rule);
            updateClassesAndAttributesUI();
            showToast(`Класс .${classToRemove} удален.`);
          };

          classesContainer.appendChild(badge);
        });
      }

      // Render custom attributes
      attributesList.innerHTML = '';
      const skipAttrs = ['id', 'class', 'style', 'data-stp-original-html', 'data-stp-modified-html', 'data-stp-original-class', 'data-stp-original-src', 'data-stp-original-class'];
      let attrCount = 0;

      Array.from(el.attributes).forEach(attr => {
        if (skipAttrs.includes(attr.name) || attr.name.startsWith('data-stp-original-')) return;

        attrCount++;
        const row = document.createElement('div');
        row.className = 'stp-attribute-row';
        row.innerHTML = `
          <div class="stp-attr-info">
            <span class="stp-attr-name">${escapeHTML(attr.name)}:</span>
            <span class="stp-attr-value" title="${escapeHTML(attr.value)}">${escapeHTML(attr.value)}</span>
          </div>
          <button class="stp-class-badge-remove" data-attr="${escapeHTML(attr.name)}">&times;</button>
        `;

        row.querySelector('.stp-class-badge-remove').onclick = (e) => {
          const attrToRemove = e.target.getAttribute('data-attr');
          el.removeAttribute(attrToRemove);

          removeHTMLRule(activeSelector, 'edit_attribute', attrToRemove);

          updateClassesAndAttributesUI();
          showToast(`Атрибут ${attrToRemove} удален.`);
        };

        attributesList.appendChild(row);
      });

      if (attrCount === 0) {
        attributesList.innerHTML = '<div style="color: #64748b; font-size: 11px; text-align: center; width: 100%;">Нет кастомных атрибутов</div>';
      }
    };

    // Add Class binding
    document.getElementById('stp-btn-add-class').onclick = () => {
      const input = document.getElementById('stp-input-add-class');
      const val = input.value.trim();
      if (!val) return;

      el.classList.add(val);
      const rule = {
        id: 'rule_' + Date.now(),
        selector: activeSelector,
        action: 'edit_attribute',
        attribute: 'class',
        value: el.className,
        active: true
      };
      addOrUpdateHTMLRule(rule);
      input.value = '';
      updateClassesAndAttributesUI();
      showToast(`Класс .${val} добавлен!`);
    };

    // Add Attribute binding
    document.getElementById('stp-btn-add-attr').onclick = () => {
      const inputName = document.getElementById('stp-input-add-attr-name');
      const inputVal = document.getElementById('stp-input-add-attr-val');
      const name = inputName.value.trim();
      const val = inputVal.value.trim();

      if (!name) return;

      el.setAttribute(name, val);
      const rule = {
        id: 'rule_' + Date.now(),
        selector: activeSelector,
        action: 'edit_attribute',
        attribute: name,
        value: val,
        active: true
      };
      addOrUpdateHTMLRule(rule);

      inputName.value = '';
      inputVal.value = '';
      updateClassesAndAttributesUI();
      showToast(`Атрибут ${name} изменен!`);
    };

    // Scope selection inside inspector modal
    const inspectorScope = document.getElementById('stp-inspector-scope');
    if (inspectorScope) {
      inspectorScope.value = activeScope;
      inspectorScope.onchange = (e) => {
        const newScope = e.target.value;
        activeScope = newScope;

        chrome.storage.local.get(['activeScopes'], (res) => {
          const scopes = res.activeScopes || {};
          scopes[hostname] = newScope;
          chrome.storage.local.set({ activeScopes: scopes }, () => {
            cachedActiveScopes = scopes;
            showToast(newScope === 'page' ? 'Область: Только на эту страницу' : 'Область: На все страницы сайта');
          });
        });
      };
    }

    // Run initial classes update
    updateClassesAndAttributesUI();
  }

  function getSelectedInspectorScope() {
    const inspectorScope = document.getElementById('stp-inspector-scope');
    return inspectorScope ? inspectorScope.value : activeScope;
  }

  function addOrUpdateHTMLRule(newRule) {
    const targetScope = getSelectedInspectorScope();
    const key = (targetScope === 'page') ? normalizeUrl(window.location.href) : hostname;

    chrome.storage.local.get(['siteTweaks'], (result) => {
      const allTweaks = result.siteTweaks || {};
      const targetData = allTweaks[key] || { css: '', js: '', html: '', htmlRules: [], enabled: true };

      if (!targetData.htmlRules) {
        targetData.htmlRules = [];
      }

      const existingIndex = targetData.htmlRules.findIndex(r => r.selector === newRule.selector && r.action === newRule.action && (newRule.action !== 'edit_attribute' || r.attribute === newRule.attribute));
      if (existingIndex >= 0) {
        targetData.htmlRules[existingIndex] = newRule;
      } else {
        targetData.htmlRules.push(newRule);
      }

      allTweaks[key] = targetData;
      chrome.storage.local.set({ siteTweaks: allTweaks }, () => {
        cachedSiteTweaks = allTweaks;
        updateBadgeCount();
        loadAndApplyTweaks();
      });
    });
  }

  function removeHTMLRule(selector, action, extraAttr) {
    const targetScope = getSelectedInspectorScope();
    const key = (targetScope === 'page') ? normalizeUrl(window.location.href) : hostname;

    chrome.storage.local.get(['siteTweaks'], (result) => {
      const allTweaks = result.siteTweaks || {};
      const targetData = allTweaks[key] || { css: '', js: '', html: '', htmlRules: [], enabled: true };

      if (targetData.htmlRules) {
        targetData.htmlRules = targetData.htmlRules.filter(r => {
          if (r.selector !== selector || r.action !== action) return true;
          if (action === 'edit_attribute' && extraAttr && r.attribute !== extraAttr) return true;
          return false;
        });
      }

      allTweaks[key] = targetData;
      chrome.storage.local.set({ siteTweaks: allTweaks }, () => {
        cachedSiteTweaks = allTweaks;
        updateBadgeCount();
        loadAndApplyTweaks();
      });
    });
  }

  function makeModalDraggable(modal) {
    const handle = modal.querySelector('#stp-drag-handle');
    let isDragging = false;
    let offsetX, offsetY;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('#stp-modal-close')) return;
      isDragging = true;
      offsetX = e.clientX - modal.getBoundingClientRect().left;
      offsetY = e.clientY - modal.getBoundingClientRect().top;
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      modal.style.left = `${e.clientX - offsetX}px`;
      modal.style.top = `${e.clientY - offsetY}px`;
      modal.style.bottom = 'auto';
      modal.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  function showToast(message) {
    const existingToast = document.querySelector('.site-tweaker-toast');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.className = 'site-tweaker-toast';
    toast.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14.01 9 11.01"></polyline>
      </svg>
      <span>${escapeHTML(message)}</span>
    `;

    document.body.appendChild(toast);
    setTimeout(() => {
      if (toast) toast.remove();
    }, 3000);
  }

  // Execute custom JavaScript code in the main world context
  function executeConsoleJS(code, sendResponse) {
    const eventId = 'dg_console_result_' + Math.random().toString(36).substr(2, 9);

    const handler = (e) => {
      window.removeEventListener(eventId, handler);
      sendResponse(e.detail);
    };

    window.addEventListener(eventId, handler);

    // Inject main world script
    const script = document.createElement('script');
    script.id = 'dg-console-runner';
    script.textContent = `
      (function() {
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
          result = eval(${JSON.stringify(code)});
        } catch (e) {
          success = false;
          errorMsg = e.message;
        }

        // Restore original console methods
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

        window.dispatchEvent(new CustomEvent('${eventId}', {
          detail: {
            success,
            result: resultStr,
            error: errorMsg,
            logs
          }
        }));
      })();
    `;

    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  // Search DOM elements by selector or text content
  function searchElements(query) {
    let elements = [];

    // 1. Try as CSS Selector
    try {
      const matches = document.querySelectorAll(query);
      matches.forEach(el => {
        if (el.closest('#site-tweaker-inspector-modal') || el.classList.contains('site-tweaker-highlight-box')) {
          return;
        }
        elements.push(el);
      });
    } catch (e) { }

    // 2. Search by text content
    const textQuery = query.toLowerCase();
    if (textQuery.length >= 2) {
      const allElems = document.querySelectorAll('body *:not(script):not(style):not(#site-tweaker-inspector-modal):not(.site-tweaker-highlight-box)');
      allElems.forEach(el => {
        if (elements.includes(el)) return;

        let directText = '';
        for (let child of el.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            directText += child.textContent;
          }
        }
        if (directText.toLowerCase().includes(textQuery)) {
          elements.push(el);
        }
      });
    }

    // Map to metadata objects (cap at 30 items)
    const limited = elements.slice(0, 30);
    return limited.map(el => {
      const selector = getUniqueCSSSelector(el);
      const textPreview = el.textContent ? el.textContent.trim().substring(0, 50) : '';
      return {
        tagName: el.tagName.toLowerCase(),
        selector: selector,
        textPreview: textPreview
      };
    });
  }

  // Highlight specific selector visual feedback
  let searchHighlightBox = null;
  function highlightSpecificElement(selector, state) {
    if (state === false) {
      if (searchHighlightBox) {
        searchHighlightBox.remove();
        searchHighlightBox = null;
      }
      return;
    }

    try {
      const el = document.querySelector(selector);
      if (!el) return;

      if (!searchHighlightBox) {
        searchHighlightBox = document.createElement('div');
        searchHighlightBox.className = 'site-tweaker-highlight-box';
        searchHighlightBox.style.borderColor = '#10b981';
        searchHighlightBox.style.backgroundColor = 'rgba(16, 185, 129, 0.2)';
        searchHighlightBox.style.boxShadow = '0 0 10px rgba(16, 185, 129, 0.4)';
        document.body.appendChild(searchHighlightBox);
      }

      const rect = el.getBoundingClientRect();
      const scrollX = window.scrollX || window.pageXOffset;
      const scrollY = window.scrollY || window.pageYOffset;

      searchHighlightBox.style.top = `${rect.top + scrollY}px`;
      searchHighlightBox.style.left = `${rect.left + scrollX}px`;
      searchHighlightBox.style.width = `${rect.width}px`;
      searchHighlightBox.style.height = `${rect.height}px`;
      searchHighlightBox.style.display = 'block';

      // Click trigger (no hover state passed) flashes and auto fades
      if (state === undefined) {
        searchHighlightBox.style.transition = 'all 0.5s ease-out';
        setTimeout(() => {
          if (searchHighlightBox) {
            searchHighlightBox.style.opacity = '0';
            setTimeout(() => {
              if (searchHighlightBox) {
                searchHighlightBox.remove();
                searchHighlightBox = null;
              }
            }, 500);
          }
        }, 1500);
      }
    } catch (e) {
      console.warn('DesignGhost: Highlight error:', selector, e);
    }
  }

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
