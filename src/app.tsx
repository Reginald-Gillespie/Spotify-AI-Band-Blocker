async function main() {
  // 1. Wait for Spicetify global API to be ready
  while (!Spicetify?.Player || !Spicetify?.Menu || !Spicetify?.LocalStorage) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const CONFIG = {
    url: "https://raw.githubusercontent.com/romiem/ai-bands/main/dist/ai-bands.json",
    cacheKey: "ai-bands:list",
    timeKey: "ai-bands:ts",
    enabledKey: "ai-bands:enabled",
    allowLikedKey: "ai-bands:allowLiked",
    ttl: 86400000, // 24 hours in milliseconds
  };

  let timeoutId: NodeJS.Timeout;
  let updateIntervalId: NodeJS.Timeout;
  let bannedArtists: Set<string> = new Set();
  let isEnabled = Spicetify.LocalStorage.get(CONFIG.enabledKey) === "true";
  let allowLikedSongs = Spicetify.LocalStorage.get(CONFIG.allowLikedKey) === "true";

  // Ban list updater
  async function updateBanList() {
    const now = Date.now();
    const lastFetchStr = Spicetify.LocalStorage.get(CONFIG.timeKey);
    const lastFetch = lastFetchStr ? parseInt(lastFetchStr) : 0;
    const cachedList = Spicetify.LocalStorage.get(CONFIG.cacheKey);

    let artistList: string[] = [];

    // If cache exists, load it first
    if (cachedList) {
      try {
        artistList = JSON.parse(cachedList);
      } catch (e) {
        console.error("[AI Blocker] Cache parse error", e);
      }
    }

    // If cache is old or empty, fetch new data
    if (now - lastFetch > CONFIG.ttl || artistList.length === 0) {
      console.log("[AI Blocker] Fetching new blocklist...");
      try {
        const res = await fetch(CONFIG.url);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);

        const data = await res.json();

        // Normalize data (handle strings or objects)
        // The JSON might be ["Name", "Name"] or [{name: "Name"}]
        const normalizedData = data
          .map((item: any) => {
            if (typeof item === "string") return item;
            if (typeof item === "object" && item.name) return item.name;
            return null;
          })
          .filter((item: string | null) => item !== null);

        if (normalizedData.length > 0) {
          artistList = normalizedData;
          Spicetify.LocalStorage.set(CONFIG.cacheKey, JSON.stringify(artistList));
          Spicetify.LocalStorage.set(CONFIG.timeKey, now.toString());
          console.log(`[AI Blocker] Updated cache with ${artistList.length} artists.`);
        }
      } catch (error) {
        console.error("[AI Blocker] Fetch failed, using cached data if available.", error);
      }
    }

    // Convert to Set for fast O(1) lookup, lowercased
    bannedArtists = new Set(artistList.map((n: string) => n.toLowerCase().trim()));
  }
  await updateBanList();

  // Schedule periodic updates of the ban list
  updateIntervalId = setInterval(() => {
    console.log("[AI Blocker] Running scheduled ban list update...");
    updateBanList();
  }, CONFIG.ttl);

  // Create menu items for flyout
  const enableToggle = new Spicetify.Menu.Item(
    "Block AI Bands",
    isEnabled,
    (menuItem) => {
      isEnabled = !isEnabled;
      Spicetify.LocalStorage.set(CONFIG.enabledKey, isEnabled.toString());
      menuItem.setState(isEnabled);
      Spicetify.showNotification(`AI Blocking ${isEnabled ? "ON" : "OFF"}`);

      if (isEnabled) checkTrack();
    }
  );

  const allowLikedToggle = new Spicetify.Menu.Item(
    "Allow Liked AI Songs",
    allowLikedSongs,
    (menuItem) => {
      allowLikedSongs = !allowLikedSongs;
      Spicetify.LocalStorage.set(CONFIG.allowLikedKey, allowLikedSongs.toString());
      menuItem.setState(allowLikedSongs);
      Spicetify.showNotification(`Allow Liked AI Songs ${allowLikedSongs ? "ON" : "OFF"}`);
    }
  );

  // Create flyout menu
  const flyoutMenu = new Spicetify.Menu.SubMenu("AI Band Blocker", [
    enableToggle,
    allowLikedToggle,
  ]);
  flyoutMenu.register();

  // Song checker
  async function checkTrack() {
    if (!isEnabled) return;

    const data = Spicetify.Player.data;
    // Guard clauses for missing data
    if (!data || !data.item || !data.item.artists) return;
    console.log(data.item.artists);

    // Check every artist on the current track
    const trackArtists = data.item.artists.map((a: any) => a.name.toLowerCase().trim());
    const match = trackArtists.find((artist: string) => bannedArtists.has(artist));

    if (match) {
      if (!Spicetify.Player.isPlaying()) return; // Do this as late a possible, spotify is laggy
      
      // Check if song is liked and we should allow it
      if (allowLikedSongs) {
        const trackUri = data.item.uri;
        if (trackUri) {
          try {
            const isLiked = await Spicetify.Platform.LibraryAPI.contains(trackUri);
            if (isLiked) {
              console.log(`[AI Blocker] Detected AI Artist: ${match}, but song is liked. Allowing...`);
              return;
            }
          } catch (error) {
            console.error("[AI Blocker] Error checking if song is liked:", error);
          }
        }
      }
      
      console.log(`[AI Blocker] Detected AI Artist: ${match}. Skipping...`);
      Spicetify.Player.next();
      Spicetify.showNotification(`Skipped AI Band: ${match.toUpperCase()}`);
    }
  }
  function queueCheck() {
    // Give a few ms before skipping to allow for registering pauses
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(checkTrack, 450);
  }
  Spicetify.Player.addEventListener("songchange", queueCheck);
  checkTrack();
}

export default main;