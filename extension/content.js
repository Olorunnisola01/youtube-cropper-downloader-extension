// Relays the current video's playback time and URL to the popup on request.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_VIDEO_INFO") {
    const video = document.querySelector("video");
    sendResponse({
      url: location.href,
      currentTime: video ? video.currentTime : 0,
      duration: video ? video.duration : 0,
      title: document.title.replace(/ - YouTube$/, "")
    });
  }
  return true;
});
