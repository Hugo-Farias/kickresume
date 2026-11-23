import {
  checkElement,
  clog,
  debounce,
  delFromCache,
  getCacheData,
  getSettings,
  getVideoId,
  makeObject,
  storeCacheTime,
  until,
} from "@/helper";
import {
  addNowPlayingTag,
  addProgressBar,
  removeNowPlayingTag,
  removeProgressBar,
} from "@/thumbnailUi";
import type { FullCache, ItemCache, SettingsChanges, SettingsT } from "@/types";
import { initialSettings } from "./popup/Settings";

const minimalSecsForCaching = 60;
let lastTimeUpdate = 0;
let firstRun = true;
let timeoutMain: ReturnType<typeof setTimeout>;
let timeoutSaveTime: ReturnType<typeof setTimeout>;
let isChatClosed = false;
let fullData: FullCache | null = null;
let isVideoResumed = false;

const devFunc = (video: HTMLVideoElement) => {
  if (!import.meta.env.DEV) return;
  setTimeout(() => {
    video.pause();
  }, 10000);
};

const createClickVideoEvent = (
  video: HTMLVideoElement,
  currentSettings: SettingsT,
) => {
  if (!currentSettings?.pauseOnClick) return;

  video.addEventListener("click", () => {
    video.pause();
  });
};

const closeSidebar = (settings: boolean) => {
  if (!settings) return;
  if (window.innerWidth < 1280) return; // Don't close sidebar on mobile, because it's needed for navigation

  const sidebarBtn = document.querySelector<HTMLButtonElement>(
    `button[aria-label^='Collapse sidebar']`,
  );

  if (!sidebarBtn) return;
  sidebarBtn.click();
};

const closeChat = (settings: boolean) => {
  if (!settings) return;

  // Close Chat Replay
  debounce(() => {
    const chatCloseBtn = document.querySelector<HTMLButtonElement>(
      "div.h-fit.w-fit.cursor-pointer > button",
    );

    isChatClosed =
      !document.querySelector<HTMLDivElement>("#channel-chatroom")?.offsetWidth;

    if (!chatCloseBtn || isChatClosed) return null;

    clog("closing chat");

    chatCloseBtn.click();
    isChatClosed = true;
  });
};

const resumeVideo = (
  video: HTMLVideoElement,
  videoId: string | null,
  videoData: ItemCache,
): boolean => {
  if (!videoId) return false;

  if (videoData) {
    clog("Data found", videoData);
    clog("Resuming video, time:", videoData.curr);
    lastTimeUpdate = videoData.curr;
    video.currentTime = videoData.curr;
    if (videoData.curr < minimalSecsForCaching) {
      fullData = delFromCache(videoId);
    }
  } else {
    clog("No data");
    lastTimeUpdate = 0;
  }

  return video.currentTime > minimalSecsForCaching;
};

const storeVideoTime = (
  video: HTMLVideoElement,
  videoId: string,
  url: string,
) => {
  if (video.currentTime < minimalSecsForCaching) return;
  const curr = video.currentTime;
  if (Math.abs(lastTimeUpdate - curr) < 10) return;

  lastTimeUpdate = curr;

  clearTimeout(timeoutSaveTime);

  timeoutSaveTime = setTimeout(() => {
    if (!videoId) return;
    const newData = makeObject(video, curr, videoId, url);

    fullData = storeCacheTime(newData, videoId);
  }, 2000);
};

const delOldCacheData = (fullData: FullCache, days: number) => {
  const currentTime = Date.now();

  for (const key in fullData) {
    const item = fullData[key];
    if (!item) continue;
    if (currentTime - item.storageTime > 1000 * 60 * 60 * 24 * days) {
      clog("❌ Deleting old cache data for video ID:", key);
      fullData = delFromCache(key);
    }
  }
};

export default defineContentScript({
  matches: ["*://kick.com/*"],
  runAt: "document_idle",
  main() {
    clog("init 🟢");
    let url = "";
    let streamerPath = window.location.href.split("/")[3];
    let videoId: string | null = getVideoId(window.location.href);
    let currentSettings: SettingsT = initialSettings;
    fullData = getCacheData();

    if (fullData) delOldCacheData(fullData, 100);

    getSettings().then((settings) => {
      if (Object.keys(settings).length) {
        currentSettings = settings;
      } else {
        chrome.storage.local.set(initialSettings);
      }
    });

    window.navigation.addEventListener("navigate", () => {
      clearTimeout(timeoutMain);
      clearTimeout(timeoutSaveTime);
      isVideoResumed = false;
      fullData = getCacheData();

      timeoutMain = setTimeout(() => {
        clog("Navigation event detected, re-initializing...");

        removeNowPlayingTag();
        removeProgressBar();

        url = window.location.href;
        videoId = getVideoId(url);
        streamerPath = url.split("/")[3];

        until(() => {
          if (document.readyState !== "complete") return;
          if (firstRun) {
            closeChat(currentSettings.autoCloseChat);
            closeSidebar(currentSettings.autoCloseSidebar);
          }
          const isProgressBarRendered = checkElement(
            "span",
            "#kb2-progress-bar",
          );

          if (fullData && !isProgressBarRendered) {
            addProgressBar(
              fullData,
              streamerPath,
              currentSettings.showProgressBar,
            );
          }

          if (!videoId) return true;

          const isTagRendered = checkElement("div", "#kb2-now-playing-tag");

          if (!isTagRendered) {
            addNowPlayingTag(currentSettings.showNowPlayingTag);
          }

          const video = document.querySelector<HTMLVideoElement>("video");
          if (!video) return;
          if (video.readyState < 4) return;
          console.log("✔️ video.paused ==>", video.paused);
          if (video.paused) return;

          const videoData = fullData?.[videoId] ?? null;

          if (videoData && !isVideoResumed) {
            isVideoResumed = resumeVideo(video, videoId, videoData);
            return false;
          }

          devFunc(video);

          if (!firstRun) return true; // Code bellow ONLY runs on first real full page load

          createClickVideoEvent(video, currentSettings);

          firstRun = false;

          video.addEventListener("timeupdate", () => {
            if (!videoId) return;
            storeVideoTime(video, videoId, url);
          });

          return true;
        }, 1000);
      }, 1000);
    });

    // Settings check section
    chrome.storage.onChanged.addListener((res: SettingsChanges) => {
      getSettings().then((settings: SettingsT) => {
        currentSettings = settings;
      });

      if (!fullData) return;

      debounce(() => {
        if (!currentSettings) return;

        if (res.autoCloseChat?.newValue === true) {
          closeChat(currentSettings.autoCloseChat);
        }

        if (res.autoCloseSidebar?.newValue === true) {
          closeSidebar(currentSettings.autoCloseSidebar);
        }

        if (res.showProgressBar?.newValue === false) {
          removeProgressBar();
        } else {
          addProgressBar(
            fullData,
            streamerPath,
            currentSettings.showProgressBar,
          );
        }

        if (!videoId) return; // Only run code below when a video is loaded

        if (res.showNowPlayingTag?.newValue === false) {
          removeNowPlayingTag();
        } else {
          addNowPlayingTag(currentSettings.showNowPlayingTag);
        }
      }, 100);
    });

    // initial load
    window.navigation.dispatchEvent(new Event("navigate"));
  },
});
