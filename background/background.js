// Background service worker for DesignGhost

chrome.runtime.onInstalled.addListener(() => {
  console.log('DesignGhost extension installed successfully.');
  
  // Ensure default storage structure is initialized
  chrome.storage.local.get(['siteTweaks', 'globalEnabled'], (result) => {
    if (result.siteTweaks === undefined) {
      chrome.storage.local.set({ siteTweaks: {} });
    }
    if (result.globalEnabled === undefined) {
      chrome.storage.local.set({ globalEnabled: true });
    }
  });
});

// Listener for messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_TAB_INFO') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        try {
          const url = new URL(tabs[0].url);
          sendResponse({
            hostname: url.hostname,
            url: tabs[0].url,
            tabId: tabs[0].id
          });
        } catch (e) {
          sendResponse({ hostname: '', url: '', tabId: null });
        }
      } else {
        sendResponse({ hostname: '', url: '', tabId: null });
      }
    });
    return true; // Async response
  }

  if (message.action === 'UPDATE_BADGE') {
    const count = message.count || 0;
    const tabId = sender.tab ? sender.tab.id : message.tabId;
    if (tabId) {
      if (count > 0) {
        chrome.action.setBadgeText({ tabId, text: count.toString() });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#6366f1' });
      } else {
        chrome.action.setBadgeText({ tabId, text: '' });
      }
    }
    sendResponse({ success: true });
  }
});
