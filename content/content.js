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
  let liveSyncInterval = null;
  let colorHistory = [];

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
    injectGoogleFonts();
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

    handleLiveSyncWatcher(pageData.liveSyncUrl || domainData.liveSyncUrl);

    // Unified enabled check: if EITHER domain or page scope has enabled=false, disable everything.
    // This ensures the popup toggle (which sets both) is always respected after page reload.
    const domainEnabled = domainData.enabled !== false;
    const pageEnabled = pageData.enabled !== false;
    const siteEnabled = domainEnabled && pageEnabled;

    if (globalEnabled && siteEnabled) {
      let mergedCss = '';
      let mergedHtmlRules = [];
      let mergedHtml = '';
      let mergedJs = '';

      mergedCss += (domainData.css || '');
      mergedHtmlRules = mergedHtmlRules.concat(domainData.htmlRules || []);
      mergedHtml += (domainData.html || '');
      mergedJs += (domainData.js || '');

      if (activeScope === 'page') {
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
      if (message.action === 'START_LIVE_SYNC') {
        handleLiveSyncWatcher(message.url);
        sendResponse({ success: true });
      }

      if (message.action === 'STOP_LIVE_SYNC') {
        handleLiveSyncWatcher(null);
        sendResponse({ success: true });
      }
      if (message.action === 'EDIT_RULE_IN_INSPECTOR') {
        try {
          const el = document.querySelector(message.selector);
          if (el) {
            if (!isInspectMode) {
              toggleInspectorMode(true);
            }
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => {
              openInspectorModal(el, message.selector);
              flashGreenElement(el);
            }, 300);
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false });
          }
        } catch (e) {
          sendResponse({ success: false });
        }
        return true;
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
  function openInspectorModal(el, forceSelector = null) {
    if (inspectorModal) {
      inspectorModal.remove();
    }

    const selectorOptions = getSelectorOptions(el);
    const defaultSelector = getUniqueCSSSelector(el);
    if (!selectorOptions.includes(defaultSelector)) {
      selectorOptions.push(defaultSelector);
    }
    if (forceSelector) {
      const idx = selectorOptions.indexOf(forceSelector);
      if (idx !== -1) selectorOptions.splice(idx, 1);
      selectorOptions.unshift(forceSelector);
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
          <div class="stp-subtabs" style="display:flex; gap:4px; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 6px;">
            <button class="stp-btn stp-btn-secondary stp-btn-xs active" id="stp-sub-tab-text" style="flex:1;">Шрифт</button>
            <button class="stp-btn stp-btn-secondary stp-btn-xs" id="stp-sub-tab-bg" style="flex:1;">Фон и Тень</button>
            <button class="stp-btn stp-btn-secondary stp-btn-xs" id="stp-sub-tab-layout" style="flex:1;">Макет</button>
          </div>

          <!-- TEXT / TYPOGRAPHY SUB-TAB -->
          <div id="stp-sub-content-text" style="display:block;">
            <div class="stp-style-grid">
              <div class="stp-style-col">
                <label class="stp-label">Цвет текста</label>
                <div class="stp-color-input-wrapper">
                  <input type="color" id="stp-color-text" class="stp-color-input">
                  <input type="text" id="stp-color-text-hex" class="stp-text-input-mini" placeholder="Auto">
                  <button class="stp-eyedropper-btn" id="stp-btn-eyedropper-text" title="Выбрать цвет с экрана">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m2 22 1-1c.6.6 1.4.6 2 0l7-7-2-2-7 7c-.6.6-.6 1.4 0 2l-1 1Zm11-11 7-7c.6-.6.6-1.4 0-2l-2-2c-.6-.6-1.4-.6-2 0l-7 7 4 4Z"/></svg>
                  </button>
                </div>
              </div>
              <div class="stp-style-col">
                <label class="stp-label">Шрифт (Google Fonts)</label>
                <select id="stp-font-family" class="stp-select">
                  <option value="">По умолчанию (System Default)</option>
                  <option value="'Inter', sans-serif">Inter</option>
                  <option value="'Montserrat', sans-serif">Montserrat</option>
                  <option value="'Roboto', sans-serif">Roboto</option>
                  <option value="'Open Sans', sans-serif">Open Sans</option>
                  <option value="'Playfair Display', serif">Playfair Display</option>
                  <option value="'Oswald', sans-serif">Oswald</option>
                  <option value="'Lora', serif">Lora</option>
                  <option value="'Nunito', sans-serif">Nunito</option>
                  <option value="'Poppins', sans-serif">Poppins</option>
                  <option value="monospace">Monospace (Код)</option>
                </select>
              </div>
            </div>

            <div class="stp-slider-group" style="margin-top: 6px;">
              <div class="stp-slider-header">
                <span class="stp-label">Размер шрифта</span>
                <span class="stp-range-val" id="stp-font-size-val">Auto</span>
              </div>
              <input type="range" id="stp-font-size" min="8" max="72" value="16" class="stp-range-slider">
            </div>

            <div class="stp-style-grid" style="margin-top: 6px;">
              <div class="stp-style-col">
                <label class="stp-label">Насыщенность (Weight)</label>
                <select id="stp-font-weight" class="stp-select">
                  <option value="">Auto</option>
                  <option value="300">Light (300)</option>
                  <option value="400">Regular (400)</option>
                  <option value="500">Medium (500)</option>
                  <option value="600">SemiBold (600)</option>
                  <option value="700">Bold (700)</option>
                </select>
              </div>
              <div class="stp-style-col">
                <label class="stp-label">Высота строки (Line)</label>
                <input type="number" id="stp-line-height" class="stp-num-input" placeholder="Auto" step="0.1" min="0.5" max="3">
              </div>
            </div>

            <div class="stp-slider-group" style="margin-top: 6px;">
              <div class="stp-slider-header">
                <span class="stp-label">Интервал букв (Letter Spacing, px)</span>
                <span class="stp-range-val" id="stp-letter-spacing-val">Auto</span>
              </div>
              <input type="range" id="stp-letter-spacing" min="-5" max="15" value="0" step="0.5" class="stp-range-slider">
            </div>
            
            <div style="margin-top: 10px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 8px;">
              <label class="stp-label">Тень текста (Text Shadow)</label>
              <div class="stp-style-grid" style="margin-top: 4px;">
                <div class="stp-style-col">
                  <label class="stp-label" style="font-size: 9px; opacity: 0.7;">X</label>
                  <input type="range" id="stp-ts-x" min="-20" max="20" value="0" class="stp-range-slider">
                </div>
                <div class="stp-style-col">
                  <label class="stp-label" style="font-size: 9px; opacity: 0.7;">Y</label>
                  <input type="range" id="stp-ts-y" min="-20" max="20" value="0" class="stp-range-slider">
                </div>
              </div>
              <div class="stp-style-grid" style="margin-top: 4px;">
                <div class="stp-style-col">
                  <label class="stp-label" style="font-size: 9px; opacity: 0.7;">Размытие (Blur)</label>
                  <input type="range" id="stp-ts-blur" min="0" max="40" value="0" class="stp-range-slider">
                </div>
                <div class="stp-style-col">
                  <label class="stp-label" style="font-size: 9px; opacity: 0.7;">Цвет</label>
                  <input type="color" id="stp-ts-color" class="stp-color-input" style="width: 100%;" value="#000000">
                </div>
              </div>
            </div>
          </div>

          <!-- BACKGROUND & SHADOWS SUB-TAB -->
          <div id="stp-sub-content-bg" style="display:none;">
            <div class="stp-style-grid">
              <div class="stp-style-col">
                <label class="stp-label">Цвет фона</label>
                <div class="stp-color-input-wrapper">
                  <input type="color" id="stp-color-bg" class="stp-color-input">
                  <input type="text" id="stp-color-bg-hex" class="stp-text-input-mini" placeholder="Auto">
                  <button class="stp-eyedropper-btn" id="stp-btn-eyedropper-bg" title="Выбрать цвет с экрана">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m2 22 1-1c.6.6 1.4.6 2 0l7-7-2-2-7 7c-.6.6-.6 1.4 0 2l-1 1Zm11-11 7-7c.6-.6.6-1.4 0-2l-2-2c-.6-.6-1.4-.6-2 0l-7 7 4 4Z"/></svg>
                  </button>
                </div>
              </div>
              <div class="stp-style-col">
                <label class="stp-label">Скругление углов</label>
                <input type="range" id="stp-border-radius" min="0" max="100" value="0" class="stp-range-slider" style="margin-top:6px;">
              </div>
            </div>

            <!-- COLOR HISTORY -->
            <div style="margin-top: 6px;">
              <div id="stp-color-history-container" style="display: flex; gap: 8px; flex-wrap: wrap; background: rgba(0,0,0,0.2); padding: 6px; border-radius: 8px; min-height: 28px;"></div>
            </div>

            <div class="stp-slider-group" style="margin-top: 6px;">
              <div class="stp-slider-header">
                <span class="stp-label">Прозрачность элемента (Opacity)</span>
                <span class="stp-range-val" id="stp-opacity-val">100%</span>
              </div>
              <input type="range" id="stp-opacity" min="0" max="100" value="100" class="stp-range-slider">
            </div>

            <!-- GRADIENTS -->
            <div style="margin-top: 10px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 8px;">
              <label class="stp-label">Линейный Градиент (Linear Gradient)</label>
              <div class="stp-style-grid" style="margin-top: 4px;">
                <div class="stp-style-col">
                  <label class="stp-label" style="font-size: 9px; opacity: 0.7;">Цвет 1 (Начало)</label>
                  <input type="color" id="stp-grad-color1" class="stp-color-input" style="width:100%;" value="#ffffff">
                </div>
                <div class="stp-style-col">
                  <label class="stp-label" style="font-size: 9px; opacity: 0.7;">Цвет 2 (Конец)</label>
                  <input type="color" id="stp-grad-color2" class="stp-color-input" style="width:100%;" value="#000000">
                </div>
              </div>
              <div class="stp-slider-group" style="margin-top: 4px;">
                <div class="stp-slider-header">
                  <span class="stp-label" style="font-size: 9px; opacity: 0.7;">Угол наклона (Angle)</span>
                  <span class="stp-range-val" id="stp-grad-angle-val">90°</span>
                </div>
                <input type="range" id="stp-grad-angle" min="0" max="360" value="90" class="stp-range-slider">
              </div>
              <button class="stp-btn stp-btn-secondary stp-btn-xs" id="stp-btn-apply-grad" style="margin-top: 4px; width: 100%;">Применить градиент</button>
              <button class="stp-btn stp-btn-secondary stp-btn-xs" id="stp-btn-remove-grad" style="margin-top: 4px; width: 100%; display:none;">Удалить градиент</button>
            </div>

            <!-- BOX SHADOW -->
            <div style="margin-top: 10px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 8px;">
              <label class="stp-label">Тень элемента (Box Shadow)</label>
              <div class="stp-style-grid" style="margin-top: 4px;">
                <div class="stp-style-col">
                  <label class="stp-label" style="font-size: 9px; opacity: 0.7;">X</label>
                  <input type="range" id="stp-bs-x" min="-50" max="50" value="0" class="stp-range-slider">
                </div>
                <div class="stp-style-col">
                  <label class="stp-label" style="font-size: 9px; opacity: 0.7;">Y</label>
                  <input type="range" id="stp-bs-y" min="-50" max="50" value="0" class="stp-range-slider">
                </div>
              </div>
              <div class="stp-style-grid" style="margin-top: 4px;">
                <div class="stp-style-col">
                  <label class="stp-label" style="font-size: 9px; opacity: 0.7;">Размытие (Blur)</label>
                  <input type="range" id="stp-bs-blur" min="0" max="100" value="0" class="stp-range-slider">
                </div>
                <div class="stp-style-col">
                  <label class="stp-label" style="font-size: 9px; opacity: 0.7;">Размах (Spread)</label>
                  <input type="range" id="stp-bs-spread" min="-50" max="50" value="0" class="stp-range-slider">
                </div>
              </div>
              <div class="stp-style-grid" style="margin-top: 4px;">
                <div class="stp-style-col">
                  <label class="stp-label" style="font-size: 9px; opacity: 0.7;">Цвет</label>
                  <input type="color" id="stp-bs-color" class="stp-color-input" style="width: 100%;" value="#000000">
                </div>
                <div class="stp-style-col" style="display:flex; align-items:center;">
                  <label class="stp-label" style="margin:0; cursor:pointer; font-size: 10px;">
                    <input type="checkbox" id="stp-bs-inset" style="margin-right:4px;"> Внутренняя (Inset)
                  </label>
                </div>
              </div>
            </div>

            <!-- BG IMAGE (From old design) -->
            <div style="margin-top: 10px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 8px;">
              <label class="stp-label">Фоновое изображение</label>
              <div class="stp-file-input-wrapper" style="display: flex; gap: 8px; margin-top: 4px;">
                <button class="stp-btn stp-btn-secondary stp-btn-sm" id="stp-btn-upload-bg-img" style="flex: 1;">Выбрать фото</button>
                <input type="file" id="stp-upload-bg-img" accept="image/*" style="display:none;">
                <button class="stp-btn stp-btn-danger" id="stp-btn-clear-bg-img" style="display: none; padding: 0 10px;" title="Удалить фон">&times;</button>
              </div>
              <div id="stp-bg-options" style="display: none; margin-top: 8px; gap: 8px; flex-direction: column;">
                <div class="stp-style-grid">
                  <div class="stp-style-col">
                    <label class="stp-label">Размер</label>
                    <select id="stp-bg-size" class="stp-select">
                      <option value="cover">Cover</option>
                      <option value="contain">Contain</option>
                      <option value="auto">Auto</option>
                    </select>
                  </div>
                  <div class="stp-style-col">
                    <label class="stp-label">Позиция</label>
                    <select id="stp-bg-position" class="stp-select">
                      <option value="center">Center</option>
                      <option value="top">Top</option>
                      <option value="bottom">Bottom</option>
                      <option value="left">Left</option>
                      <option value="right">Right</option>
                    </select>
                  </div>
                </div>
                <select id="stp-bg-repeat" class="stp-select">
                  <option value="no-repeat">Не повторять</option>
                  <option value="repeat">Повторять</option>
                </select>
              </div>
            </div>
          </div>

          <!-- LAYOUT SUB-TAB -->
          <div id="stp-sub-content-layout" style="display:none;">
            <div class="stp-style-grid">
              <div class="stp-style-col">
                <label class="stp-label">Внутр. отступ (Padding, px)</label>
                <input type="number" id="stp-padding" class="stp-num-input" placeholder="Auto" min="0">
              </div>
              <div class="stp-style-col">
                <label class="stp-label">Внешн. отступ (Margin, px)</label>
                <input type="number" id="stp-margin" class="stp-num-input" placeholder="Auto" min="0">
              </div>
            </div>

            <div style="margin-top: 10px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 10px;">
              <span class="stp-label" style="text-align: left; margin-bottom: 6px; font-weight: bold; color: #a855f7;">Структура (Flexbox / Grid)</span>
              <div class="stp-style-grid">
                <div class="stp-style-col">
                  <label class="stp-label">Режим (Display)</label>
                  <select id="stp-layout-display" class="stp-select">
                    <option value="">По умолчанию</option>
                    <option value="flex">Flexbox (flex)</option>
                    <option value="grid">Grid (grid)</option>
                    <option value="block">Block</option>
                    <option value="inline-block">Inline-block</option>
                  </select>
                </div>
                <div class="stp-style-col">
                  <label class="stp-label">Направление (Dir)</label>
                  <select id="stp-layout-direction" class="stp-select">
                    <option value="">По умолчанию</option>
                    <option value="row">Строка (row)</option>
                    <option value="column">Колонка (column)</option>
                  </select>
                </div>
              </div>
              <div class="stp-style-grid" style="margin-top: 6px;">
                <div class="stp-style-col">
                  <label class="stp-label">Горизонталь (Justify)</label>
                  <select id="stp-layout-justify" class="stp-select">
                    <option value="">По умолчанию</option>
                    <option value="flex-start">Start</option>
                    <option value="center">Center</option>
                    <option value="flex-end">End</option>
                    <option value="space-between">Space-between</option>
                    <option value="space-around">Space-around</option>
                  </select>
                </div>
                <div class="stp-style-col">
                  <label class="stp-label">Вертикаль (Align)</label>
                  <select id="stp-layout-align" class="stp-select">
                    <option value="">По умолчанию</option>
                    <option value="stretch">Stretch</option>
                    <option value="center">Center</option>
                    <option value="flex-start">Start</option>
                    <option value="flex-end">End</option>
                  </select>
                </div>
              </div>
              <div class="stp-style-grid" style="margin-top: 6px;">
                <div class="stp-style-col">
                  <label class="stp-label">Промежуток (Gap, px)</label>
                  <input type="number" id="stp-layout-gap" class="stp-num-input" placeholder="По умолчанию" min="0">
                </div>
                <div class="stp-style-col">
                  <label class="stp-label">Перенос (Wrap)</label>
                  <select id="stp-layout-wrap" class="stp-select">
                    <option value="">По умолчанию</option>
                    <option value="nowrap">No Wrap</option>
                    <option value="wrap">Wrap</option>
                  </select>
                </div>
              </div>
            </div>

            <!-- IMAGE REPLACEMENT -->
            ${isImgTag ? `
            <div style="margin-top: 10px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 10px;">
              <label class="stp-label">Замена картинки (src)</label>
              <div class="stp-file-input-wrapper" style="display: flex; gap: 8px;">
                <button class="stp-btn stp-btn-secondary stp-btn-sm" id="stp-btn-upload-img-src" style="flex: 1;">Выбрать фото</button>
                <input type="file" id="stp-upload-img-src" accept="image/*" style="display:none;">
                <button class="stp-btn stp-btn-danger" id="stp-btn-revert-img-src" style="display: none; padding: 0 10px;" title="Сбросить картинку">&times;</button>
              </div>
              <div id="stp-img-options" style="display: none; margin-top: 8px; gap: 8px; flex-direction: column;">
                <div class="stp-style-grid">
                  <div class="stp-style-col">
                    <label class="stp-label">Размер фото</label>
                    <select id="stp-img-fit" class="stp-select">
                      <option value="fill">Растянуть (fill)</option>
                      <option value="contain">Вписать (contain)</option>
                      <option value="cover">Заполнить (cover)</option>
                    </select>
                  </div>
                  <div class="stp-style-col">
                    <label class="stp-label">Позиция</label>
                    <select id="stp-img-position" class="stp-select">
                      <option value="center">Центр</option>
                      <option value="top">Сверху</option>
                      <option value="bottom">Снизу</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>` : ''}
          </div>

          <div class="stp-actions" style="margin-top: 12px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 12px;">
            <button class="stp-btn stp-btn-primary" id="stp-save-styles">Сохранить стили</button>
            <button class="stp-btn stp-btn-warning" id="stp-reset-element-styles">Сбросить стили</button>
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

    // Sub-tab switching logic
    const subTabTextBtn = document.getElementById('stp-sub-tab-text');
    const subTabBgBtn = document.getElementById('stp-sub-tab-bg');
    const subTabLayoutBtn = document.getElementById('stp-sub-tab-layout');

    const subContentText = document.getElementById('stp-sub-content-text');
    const subContentBg = document.getElementById('stp-sub-content-bg');
    const subContentLayout = document.getElementById('stp-sub-content-layout');

    function resetSubTabs() {
      if (subTabTextBtn) subTabTextBtn.classList.remove('active');
      if (subTabBgBtn) subTabBgBtn.classList.remove('active');
      if (subTabLayoutBtn) subTabLayoutBtn.classList.remove('active');
      if (subContentText) subContentText.style.display = 'none';
      if (subContentBg) subContentBg.style.display = 'none';
      if (subContentLayout) subContentLayout.style.display = 'none';
    }

    if (subTabTextBtn) {
      subTabTextBtn.onclick = () => {
        resetSubTabs();
        subTabTextBtn.classList.add('active');
        subContentText.style.display = 'block';
      };
    }
    if (subTabBgBtn) {
      subTabBgBtn.onclick = () => {
        resetSubTabs();
        subTabBgBtn.classList.add('active');
        subContentBg.style.display = 'block';
      };
    }
    if (subTabLayoutBtn) {
      subTabLayoutBtn.onclick = () => {
        resetSubTabs();
        subTabLayoutBtn.classList.add('active');
        subContentLayout.style.display = 'block';
      };
    }


    // Pre-populate visually with computed values
    const computed = window.getComputedStyle(el);
    const textColHex = rgbToHex(computed.color);
    
    // Background prep
    let bgColHex = '#000000';
    let gradCol1 = '#ffffff';
    let gradCol2 = '#000000';
    let gradAngle = 90;
    const bgStr = computed.background || computed.backgroundImage || '';
    if (bgStr.includes('linear-gradient')) {
      // Basic gradient extraction for UI (fallback to default if complex)
      const match = bgStr.match(/linear-gradient\((\d+)deg,\s*(rgb\([^)]+\)|#[a-f0-9]+)\s*\d*%?,\s*(rgb\([^)]+\)|#[a-f0-9]+)/i);
      if (match) {
        gradAngle = parseInt(match[1]);
        gradCol1 = match[2].includes('rgb') ? rgbToHex(match[2]) : match[2];
        gradCol2 = match[3].includes('rgb') ? rgbToHex(match[3]) : match[3];
      }
      const bgMatch = computed.backgroundColor;
      bgColHex = (bgMatch && bgMatch !== 'rgba(0, 0, 0, 0)') ? rgbToHex(bgMatch) : '#000000';
    } else {
      bgColHex = rgbToHex(computed.backgroundColor);
    }

    // Shadow prep (Box Shadow)
    let bsX = 0, bsY = 0, bsBlur = 0, bsSpread = 0, bsColor = '#000000', bsInset = false;
    if (computed.boxShadow && computed.boxShadow !== 'none') {
      const parts = computed.boxShadow.split(/ (?![^(]*\))/);
      const inset = parts.includes('inset');
      bsInset = inset;
      const rgbMatch = computed.boxShadow.match(/rgb[a]?\([^)]+\)/);
      if (rgbMatch) bsColor = rgbToHex(rgbMatch[0]);
      const pxVals = computed.boxShadow.match(/-?\d+px/g);
      if (pxVals && pxVals.length >= 3) {
        bsX = parseInt(pxVals[0]);
        bsY = parseInt(pxVals[1]);
        bsBlur = parseInt(pxVals[2]);
        if (pxVals[3]) bsSpread = parseInt(pxVals[3]);
      }
    }

    // Shadow prep (Text Shadow)
    let tsX = 0, tsY = 0, tsBlur = 0, tsColor = '#000000';
    if (computed.textShadow && computed.textShadow !== 'none') {
      const rgbMatch = computed.textShadow.match(/rgb[a]?\([^)]+\)/);
      if (rgbMatch) tsColor = rgbToHex(rgbMatch[0]);
      const pxVals = computed.textShadow.match(/-?\d+px/g);
      if (pxVals && pxVals.length >= 3) {
        tsX = parseInt(pxVals[0]);
        tsY = parseInt(pxVals[1]);
        tsBlur = parseInt(pxVals[2]);
      }
    }

    // Typography elements
    const colorText = document.getElementById('stp-color-text');
    const colorTextHex = document.getElementById('stp-color-text-hex');
    const fontSelect = document.getElementById('stp-font-family');
    const fontSize = document.getElementById('stp-font-size');
    const fontSizeVal = document.getElementById('stp-font-size-val');
    const fontWeightSelect = document.getElementById('stp-font-weight');
    const lineHeightInput = document.getElementById('stp-line-height');
    const letterSpacing = document.getElementById('stp-letter-spacing');
    const letterSpacingVal = document.getElementById('stp-letter-spacing-val');
    
    // Text Shadow elements
    const tsXInput = document.getElementById('stp-ts-x');
    const tsYInput = document.getElementById('stp-ts-y');
    const tsBlurInput = document.getElementById('stp-ts-blur');
    const tsColorInput = document.getElementById('stp-ts-color');

    // Background elements
    const colorBg = document.getElementById('stp-color-bg');
    const colorBgHex = document.getElementById('stp-color-bg-hex');
    const borderRadius = document.getElementById('stp-border-radius');
    const opacity = document.getElementById('stp-opacity');
    const opacityVal = document.getElementById('stp-opacity-val');
    
    // Gradient elements
    const gradCol1Input = document.getElementById('stp-grad-color1');
    const gradCol2Input = document.getElementById('stp-grad-color2');
    const gradAngleInput = document.getElementById('stp-grad-angle');
    const gradAngleVal = document.getElementById('stp-grad-angle-val');
    const btnApplyGrad = document.getElementById('stp-btn-apply-grad');
    const btnRemoveGrad = document.getElementById('stp-btn-remove-grad');

    // Box Shadow elements
    const bsXInput = document.getElementById('stp-bs-x');
    const bsYInput = document.getElementById('stp-bs-y');
    const bsBlurInput = document.getElementById('stp-bs-blur');
    const bsSpreadInput = document.getElementById('stp-bs-spread');
    const bsColorInput = document.getElementById('stp-bs-color');
    const bsInsetInput = document.getElementById('stp-bs-inset');

    // Layout elements
    const paddingInput = document.getElementById('stp-padding');
    const marginInput = document.getElementById('stp-margin');
    const displaySelect = document.getElementById('stp-layout-display');
    const directionSelect = document.getElementById('stp-layout-direction');
    const justifySelect = document.getElementById('stp-layout-justify');
    const alignSelect = document.getElementById('stp-layout-align');
    const gapInput = document.getElementById('stp-layout-gap');
    const wrapSelect = document.getElementById('stp-layout-wrap');

    // Image/Background controls
    const uploadBgImg = document.getElementById('stp-upload-bg-img');
    const btnUploadBgImg = document.getElementById('stp-btn-upload-bg-img');
    const btnClearBgImg = document.getElementById('stp-btn-clear-bg-img');

    // Init Typography UI
    colorText.value = textColHex;
    colorTextHex.value = textColHex;
    const currentFSize = parseFloat(computed.fontSize);
    fontSize.value = currentFSize;
    fontSizeVal.textContent = currentFSize + 'px';
    if (fontSelect) fontSelect.value = el.style.fontFamily || '';
    if (fontWeightSelect) fontWeightSelect.value = el.style.fontWeight || '';
    if (lineHeightInput) {
      if (computed.lineHeight && computed.lineHeight !== 'normal') {
        const lh = parseFloat(computed.lineHeight) / parseFloat(computed.fontSize);
        lineHeightInput.value = lh ? lh.toFixed(1) : '';
      }
    }
    const currentLs = parseFloat(computed.letterSpacing) || 0;
    if (letterSpacing) letterSpacing.value = currentLs;
    if (letterSpacingVal) letterSpacingVal.textContent = currentLs + 'px';
    
    // Init Text Shadow UI
    if (tsXInput) tsXInput.value = tsX;
    if (tsYInput) tsYInput.value = tsY;
    if (tsBlurInput) tsBlurInput.value = tsBlur;
    if (tsColorInput) tsColorInput.value = tsColor;

    // Init BG UI
    colorBg.value = bgColHex;
    colorBgHex.value = bgColHex;
    const currentBRad = parseFloat(computed.borderRadius) || 0;
    borderRadius.value = currentBRad;
    const currentOp = Math.round(parseFloat(computed.opacity) * 100) || 100;
    opacity.value = currentOp;
    opacityVal.textContent = currentOp + '%';

    // Init Gradient UI
    if (gradCol1Input) gradCol1Input.value = gradCol1;
    if (gradCol2Input) gradCol2Input.value = gradCol2;
    if (gradAngleInput) {
      gradAngleInput.value = gradAngle;
      gradAngleVal.textContent = gradAngle + '°';
    }
    if (el.style.backgroundImage && el.style.backgroundImage.includes('linear-gradient')) {
      if (btnRemoveGrad) btnRemoveGrad.style.display = 'block';
    }

    // Init Box Shadow UI
    if (bsXInput) bsXInput.value = bsX;
    if (bsYInput) bsYInput.value = bsY;
    if (bsBlurInput) bsBlurInput.value = bsBlur;
    if (bsSpreadInput) bsSpreadInput.value = bsSpread;
    if (bsColorInput) bsColorInput.value = bsColor;
    if (bsInsetInput) bsInsetInput.checked = bsInset;

    // Init Layout UI
    paddingInput.value = parseInt(computed.paddingTop) || '';
    marginInput.value = parseInt(computed.marginTop) || '';
    if (displaySelect) displaySelect.value = el.style.display || '';
    if (directionSelect) directionSelect.value = el.style.flexDirection || '';
    if (justifySelect) justifySelect.value = el.style.justifyContent || '';
    if (alignSelect) alignSelect.value = el.style.alignItems || '';
    if (gapInput) gapInput.value = parseInt(el.style.gap) || '';
    if (wrapSelect) wrapSelect.value = el.style.flexWrap || '';

    loadColorHistory();

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
        opacity.value = val.opacity !== undefined ? Math.round(parseFloat(val.opacity) * 100) : currentOp;
        opacityVal.textContent = opacity.value + '%';
        paddingInput.value = val.padding ? parseInt(val.padding) : '';
        marginInput.value = val.margin ? parseInt(val.margin) : '';
        if (fontSelect) fontSelect.value = val['font-family'] || '';
        if (fontWeightSelect) fontWeightSelect.value = val['font-weight'] || '';
        if (displaySelect) displaySelect.value = val['display'] || '';
        if (directionSelect) directionSelect.value = val['flex-direction'] || '';
        if (justifySelect) justifySelect.value = val['justify-content'] || '';
        if (alignSelect) alignSelect.value = val['align-items'] || '';
        if (gapInput) gapInput.value = val['gap'] ? parseInt(val['gap']) : '';
        if (wrapSelect) wrapSelect.value = val['flex-wrap'] || '';
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
    if (computed.backgroundImage && computed.backgroundImage !== 'none' && !computed.backgroundImage.includes('linear-gradient')) {
      if (btnClearBgImg) btnClearBgImg.style.display = 'block';
      if (bgOptionsContainer) bgOptionsContainer.style.display = 'flex';
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
    }

    // Load dynamic google fonts script
    function loadGoogleFont(fontFamily) {
      if (!fontFamily) return;
      const cleanFontName = fontFamily.replace(/['"]/g, '').split(',')[0].trim();
      const url = `https://fonts.googleapis.com/css2?family=${cleanFontName.replace(/ /g, '+')}:wght@300;400;500;600;700&display=swap`;
      
      let link = document.head.querySelector(`link[href="${url}"]`);
      if (!link) {
        link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = url;
        document.head.appendChild(link);
      }
    }

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

      // Typography
      if (fontSelect && fontSelect.value) {
        loadGoogleFont(fontSelect.value);
        el.style.setProperty('font-family', fontSelect.value, 'important');
      } else {
        el.style.removeProperty('font-family');
      }

      if (fontWeightSelect && fontWeightSelect.value) {
        el.style.setProperty('font-weight', fontWeightSelect.value, 'important');
      } else {
        el.style.removeProperty('font-weight');
      }

      if (lineHeightInput && lineHeightInput.value) {
        el.style.setProperty('line-height', lineHeightInput.value, 'important');
      } else {
        el.style.removeProperty('line-height');
      }

      if (letterSpacing && letterSpacing.value != 0) {
        el.style.setProperty('letter-spacing', letterSpacing.value + 'px', 'important');
      } else {
        el.style.removeProperty('letter-spacing');
      }

      // Text shadow
      if (tsXInput && tsYInput && tsBlurInput && tsColorInput) {
        if (tsXInput.value == 0 && tsYInput.value == 0 && tsBlurInput.value == 0) {
          el.style.removeProperty('text-shadow');
        } else {
          el.style.setProperty('text-shadow', `${tsXInput.value}px ${tsYInput.value}px ${tsBlurInput.value}px ${tsColorInput.value}`, 'important');
        }
      }

      // Box shadow
      if (bsXInput && bsYInput && bsBlurInput && bsSpreadInput && bsColorInput && bsInsetInput) {
        if (bsXInput.value == 0 && bsYInput.value == 0 && bsBlurInput.value == 0 && bsSpreadInput.value == 0) {
          el.style.removeProperty('box-shadow');
        } else {
          const insetText = bsInsetInput.checked ? 'inset ' : '';
          el.style.setProperty('box-shadow', `${insetText}${bsXInput.value}px ${bsYInput.value}px ${bsBlurInput.value}px ${bsSpreadInput.value}px ${bsColorInput.value}`, 'important');
        }
      }

      // Layout
      if (displaySelect && displaySelect.value) {
        el.style.setProperty('display', displaySelect.value, 'important');
      } else {
        el.style.removeProperty('display');
      }
      if (directionSelect && directionSelect.value) {
        el.style.setProperty('flex-direction', directionSelect.value, 'important');
      } else {
        el.style.removeProperty('flex-direction');
      }
      if (justifySelect && justifySelect.value) {
        el.style.setProperty('justify-content', justifySelect.value, 'important');
      } else {
        el.style.removeProperty('justify-content');
      }
      if (alignSelect && alignSelect.value) {
        el.style.setProperty('align-items', alignSelect.value, 'important');
      } else {
        el.style.removeProperty('align-items');
      }
      if (gapInput && gapInput.value !== '') {
        el.style.setProperty('gap', gapInput.value + 'px', 'important');
      } else {
        el.style.removeProperty('gap');
      }
      if (wrapSelect && wrapSelect.value) {
        el.style.setProperty('flex-wrap', wrapSelect.value, 'important');
      } else {
        el.style.removeProperty('flex-wrap');
      }

      // Image & BG fallback handles...
      if (isImgTag && selectImgFit && selectImgFit.value) {
        el.style.setProperty('object-fit', selectImgFit.value, 'important');
      }
    }

    // Attach Event Listeners
    colorText.oninput = () => { colorTextHex.value = colorText.value; applyLiveStyles(); };
    colorTextHex.oninput = () => { if (/^#[0-9A-F]{6}$/i.test(colorTextHex.value)) { colorText.value = colorTextHex.value; applyLiveStyles(); }};
    colorBg.oninput = () => { colorBgHex.value = colorBg.value; applyLiveStyles(); };
    colorBgHex.oninput = () => { if (/^#[0-9A-F]{6}$/i.test(colorBgHex.value)) { colorBg.value = colorBgHex.value; applyLiveStyles(); }};
    
    fontSize.oninput = () => { fontSizeVal.textContent = fontSize.value + 'px'; applyLiveStyles(); };
    borderRadius.oninput = () => { applyLiveStyles(); };
    opacity.oninput = () => { opacityVal.textContent = opacity.value + '%'; applyLiveStyles(); };
    
    if (fontSelect) fontSelect.onchange = applyLiveStyles;
    if (fontWeightSelect) fontWeightSelect.onchange = applyLiveStyles;
    if (lineHeightInput) lineHeightInput.oninput = applyLiveStyles;
    if (letterSpacing) letterSpacing.oninput = () => { letterSpacingVal.textContent = letterSpacing.value + 'px'; applyLiveStyles(); };
    
    if (tsXInput) tsXInput.oninput = applyLiveStyles;
    if (tsYInput) tsYInput.oninput = applyLiveStyles;
    if (tsBlurInput) tsBlurInput.oninput = applyLiveStyles;
    if (tsColorInput) tsColorInput.oninput = applyLiveStyles;

    if (bsXInput) bsXInput.oninput = applyLiveStyles;
    if (bsYInput) bsYInput.oninput = applyLiveStyles;
    if (bsBlurInput) bsBlurInput.oninput = applyLiveStyles;
    if (bsSpreadInput) bsSpreadInput.oninput = applyLiveStyles;
    if (bsColorInput) bsColorInput.oninput = applyLiveStyles;
    if (bsInsetInput) bsInsetInput.onchange = applyLiveStyles;

    if (btnApplyGrad && gradCol1Input && gradCol2Input && gradAngleInput) {
      gradAngleInput.oninput = () => { gradAngleVal.textContent = gradAngleInput.value + '°'; };
      btnApplyGrad.onclick = () => {
        const bgVal = `linear-gradient(${gradAngleInput.value}deg, ${gradCol1Input.value}, ${gradCol2Input.value})`;
        el.style.setProperty('background-image', bgVal, 'important');
        if (btnRemoveGrad) btnRemoveGrad.style.display = 'block';
      };
    }
    if (btnRemoveGrad) {
      btnRemoveGrad.onclick = () => {
        el.style.removeProperty('background-image');
        btnRemoveGrad.style.display = 'none';
      };
    }

    paddingInput.oninput = applyLiveStyles;
    marginInput.oninput = applyLiveStyles;
    if (displaySelect) displaySelect.onchange = applyLiveStyles;
    if (directionSelect) directionSelect.onchange = applyLiveStyles;
    if (justifySelect) justifySelect.onchange = applyLiveStyles;
    if (alignSelect) alignSelect.onchange = applyLiveStyles;
    if (gapInput) gapInput.oninput = applyLiveStyles;
    if (wrapSelect) wrapSelect.onchange = applyLiveStyles;

    // BG Image upload
    if (btnUploadBgImg && uploadBgImg) {
      btnUploadBgImg.onclick = () => uploadBgImg.click();
      uploadBgImg.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        showToast('Сжатие фонового изображения...');
        compressAndResizeImage(file, 1200, 0.8).then((dataUrl) => {
          el.style.setProperty('background-image', `url("${dataUrl}")`, 'important');
          if (btnClearBgImg) btnClearBgImg.style.display = 'block';
          if (bgOptionsContainer) bgOptionsContainer.style.display = 'flex';
          applyLiveStyles();
          showToast('Фоновое изображение установлено!');
        });
      };
    }
    if (btnClearBgImg) {
      btnClearBgImg.onclick = () => {
        el.style.removeProperty('background-image');
        uploadBgImg.value = '';
        btnClearBgImg.style.display = 'none';
        if (bgOptionsContainer) bgOptionsContainer.style.display = 'none';
        showToast('Фоновое изображение удалено.');
      };
    }
    
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

      if (paddingInput.value !== '') stylesObj['padding'] = paddingInput.value + 'px';
      if (marginInput.value !== '') stylesObj['margin'] = marginInput.value + 'px';

      if (fontSelect && fontSelect.value) stylesObj['font-family'] = fontSelect.value;
      if (fontWeightSelect && fontWeightSelect.value) stylesObj['font-weight'] = fontWeightSelect.value;
      if (lineHeightInput && lineHeightInput.value) stylesObj['line-height'] = lineHeightInput.value;
      if (letterSpacing && letterSpacing.value != 0) stylesObj['letter-spacing'] = letterSpacing.value + 'px';

      if (tsXInput && tsYInput && tsBlurInput && tsColorInput) {
        if (!(tsXInput.value == 0 && tsYInput.value == 0 && tsBlurInput.value == 0)) {
          stylesObj['text-shadow'] = `${tsXInput.value}px ${tsYInput.value}px ${tsBlurInput.value}px ${tsColorInput.value}`;
        }
      }

      if (bsXInput && bsYInput && bsBlurInput && bsSpreadInput && bsColorInput && bsInsetInput) {
        if (!(bsXInput.value == 0 && bsYInput.value == 0 && bsBlurInput.value == 0 && bsSpreadInput.value == 0)) {
          const insetText = bsInsetInput.checked ? 'inset ' : '';
          stylesObj['box-shadow'] = `${insetText}${bsXInput.value}px ${bsYInput.value}px ${bsBlurInput.value}px ${bsSpreadInput.value}px ${bsColorInput.value}`;
        }
      }

      const bgImg = el.style.backgroundImage;
      if (bgImg && bgImg !== 'none') {
        stylesObj['background-image'] = bgImg;
        // Check if old image options exist
        const selectBgSize = document.getElementById('stp-bg-size');
        const selectBgPosition = document.getElementById('stp-bg-position');
        const selectBgRepeat = document.getElementById('stp-bg-repeat');

        if (selectBgSize && selectBgSize.value) {
          stylesObj['background-size'] = selectBgSize.value;
        }
        if (selectBgPosition && selectBgPosition.value) {
          stylesObj['background-position'] = selectBgPosition.value;
        }
        if (selectBgRepeat && selectBgRepeat.value) {
          stylesObj['background-repeat'] = selectBgRepeat.value;
        }
      }

      if (isImgTag) {
        const selectImgFit = document.getElementById('stp-img-fit');
        if (selectImgFit && selectImgFit.value) {
          stylesObj['object-fit'] = selectImgFit.value;
        }
      }

      if (displaySelect && displaySelect.value) stylesObj['display'] = displaySelect.value;
      if (directionSelect && directionSelect.value) stylesObj['flex-direction'] = directionSelect.value;
      if (justifySelect && justifySelect.value) stylesObj['justify-content'] = justifySelect.value;
      if (alignSelect && alignSelect.value) stylesObj['align-items'] = alignSelect.value;
      if (gapInput && gapInput.value !== '') stylesObj['gap'] = gapInput.value + 'px';
      if (wrapSelect && wrapSelect.value) stylesObj['flex-wrap'] = wrapSelect.value;

      addColorToHistory(colorText.value);
      addColorToHistory(colorBg.value);

      const rule = {
        id: 'rule_' + Date.now(),
        selector: activeSelector,
        action: 'edit_style',
        value: stylesObj,
        active: true
      };

      addOrUpdateHTMLRule(rule);
      showToast('Визуальные стили элемента сохранены!');
      flashGreenElement(el);
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
      el.style.removeProperty('font-family');
      el.style.removeProperty('font-weight');
      el.style.removeProperty('line-height');
      el.style.removeProperty('letter-spacing');
      el.style.removeProperty('text-shadow');
      el.style.removeProperty('box-shadow');
      el.style.removeProperty('background-image');
      el.style.removeProperty('background-size');
      el.style.removeProperty('background-position');
      el.style.removeProperty('background-repeat');
      el.style.removeProperty('object-fit');
      el.style.removeProperty('object-position');
      el.style.removeProperty('display');
      el.style.removeProperty('flex-direction');
      el.style.removeProperty('justify-content');
      el.style.removeProperty('align-items');
      el.style.removeProperty('gap');
      el.style.removeProperty('flex-wrap');

      // Update UI components
      loadRuleValues(activeSelector);
      showToast('Все измененные стили сброшены.');
    };

    // HTML Save
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
      flashGreenElement(el);
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
      flashGreenElement(el);
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
      flashGreenElement(el);
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

    // === Close / Done button handlers ===
    const closeModal = () => {
      if (inspectorModal) {
        inspectorModal.remove();
        inspectorModal = null;
      }
      toggleInspectorMode(false);
    };

    const closeBtn = document.getElementById('stp-modal-close');
    const finishBtn = document.getElementById('stp-finish-inspect');
    if (closeBtn) closeBtn.onclick = closeModal;
    if (finishBtn) finishBtn.onclick = closeModal;
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

  function injectGoogleFonts() {
    if (!document.getElementById('stp-google-fonts')) {
      const link = document.createElement('link');
      link.id = 'stp-google-fonts';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=Montserrat:wght@300;400;600;700&family=Roboto:wght@300;400;500;700&family=Open+Sans:wght@300;400;600;700&family=Playfair+Display:ital,wght@0,400;0,700;1,400&display=swap';
      
      const target = document.head || document.documentElement;
      if (target) {
        target.appendChild(link);
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          if (document.head) document.head.appendChild(link);
        });
      }
    }
  }

  function handleLiveSyncWatcher(url) {
    if (!url) {
      if (liveSyncInterval) {
        clearInterval(liveSyncInterval);
        liveSyncInterval = null;
      }
      const link = document.getElementById('stp-live-sync-css');
      if (link) link.remove();
      return;
    }

    if (liveSyncInterval) {
      // Re-trigger if URL changed
      const link = document.getElementById('stp-live-sync-css');
      if (link && link.getAttribute('data-base-url') === url) {
        return;
      }
      clearInterval(liveSyncInterval);
    }

    let link = document.getElementById('stp-live-sync-css');
    if (!link) {
      link = document.createElement('link');
      link.id = 'stp-live-sync-css';
      link.rel = 'stylesheet';
      const target = document.head || document.documentElement;
      if (target) {
        target.appendChild(link);
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          if (document.head) document.head.appendChild(link);
        });
      }
    }
    link.setAttribute('data-base-url', url);

    liveSyncInterval = setInterval(() => {
      link.href = url + '?t=' + Date.now();
    }, 1000);
  }

  function loadColorHistory() {
    chrome.storage.local.get(['stpColorHistory'], (res) => {
      colorHistory = res.stpColorHistory || ['#6366F1', '#10B981', '#EF4444', '#F59E0B', '#3B82F6', '#EC4899'];
      renderColorHistoryUI();
    });
  }

  function addColorToHistory(color) {
    if (!color || color === 'transparent') return;
    color = color.toUpperCase();
    colorHistory = colorHistory.filter(c => c !== color);
    colorHistory.unshift(color);
    if (colorHistory.length > 6) {
      colorHistory.pop();
    }
    chrome.storage.local.set({ stpColorHistory: colorHistory }, () => {
      renderColorHistoryUI();
    });
  }

  function renderColorHistoryUI() {
    const container = document.getElementById('stp-color-history-container');
    if (!container) return;
    container.innerHTML = '';
    colorHistory.forEach(color => {
      const circle = document.createElement('div');
      circle.style.width = '18px';
      circle.style.height = '18px';
      circle.style.borderRadius = '50%';
      circle.style.backgroundColor = color;
      circle.style.cursor = 'pointer';
      circle.style.border = '1px solid rgba(255,255,255,0.2)';
      circle.title = color + ' (L-click for BG, R-click for Text)';
      
      circle.onclick = (e) => {
        e.preventDefault();
        const colorBg = document.getElementById('stp-color-bg');
        const colorBgHex = document.getElementById('stp-color-bg-hex');
        if (colorBg && colorBgHex) {
          colorBg.value = color;
          colorBgHex.value = color;
          applyLiveStyles();
          showToast(`Цвет фона изменен на ${color}`);
        }
      };

      circle.oncontextmenu = (e) => {
        e.preventDefault();
        const colorText = document.getElementById('stp-color-text');
        const colorTextHex = document.getElementById('stp-color-text-hex');
        if (colorText && colorTextHex) {
          colorText.value = color;
          colorTextHex.value = color;
          applyLiveStyles();
          showToast(`Цвет текста изменен на ${color}`);
        }
      };

      container.appendChild(circle);
    });
  }

  function flashGreenElement(el) {
    if (!el) return;
    const overlay = document.createElement('div');
    overlay.className = 'site-tweaker-highlight-box';
    overlay.style.borderColor = '#10b981';
    overlay.style.backgroundColor = 'rgba(16, 185, 129, 0.35)';
    overlay.style.boxShadow = '0 0 15px rgba(16, 185, 129, 0.6)';
    overlay.style.pointerEvents = 'none';
    overlay.style.position = 'absolute';
    overlay.style.zIndex = '9999999';
    overlay.style.transition = 'all 1s cubic-bezier(0.16, 1, 0.3, 1)';
    document.body.appendChild(overlay);

    const updatePosition = () => {
      const rect = el.getBoundingClientRect();
      const scrollX = window.scrollX || window.pageXOffset;
      const scrollY = window.scrollY || window.pageYOffset;
      overlay.style.top = `${rect.top + scrollY}px`;
      overlay.style.left = `${rect.left + scrollX}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
    };
    updatePosition();

    requestAnimationFrame(() => {
      overlay.style.opacity = '0';
      overlay.style.transform = 'scale(1.05)';
    });

    setTimeout(() => {
      overlay.remove();
    }, 1000);
  }

})();
