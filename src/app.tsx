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
    tagSkipStatesKey: "ai-bands:tagSkipStates",
    ttl: 86400000, // 24 hours in milliseconds
  };

  let timeoutId: NodeJS.Timeout;
  let updateIntervalId: NodeJS.Timeout;
  let artistData: Map<string, string[]> = new Map(); // artist name -> tags
  let tagSkipStates: Map<string, boolean> = new Map(); // tag -> should skip
  let isEnabled = Spicetify.LocalStorage.get(CONFIG.enabledKey) === "true";
  let allowLikedSongs = Spicetify.LocalStorage.get(CONFIG.allowLikedKey) === "true";

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Load tag skip states from storage
  function loadTagSkipStates() {
    const stored = Spicetify.LocalStorage.get(CONFIG.tagSkipStatesKey);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        tagSkipStates = new Map(Object.entries(parsed));
      } catch (e) {
        console.error("[AI Blocker] Failed to parse tag skip states", e);
      }
    }
  }

  // Save tag skip states to storage
  function saveTagSkipStates() {
    const obj = Object.fromEntries(tagSkipStates);
    Spicetify.LocalStorage.set(CONFIG.tagSkipStatesKey, JSON.stringify(obj));
  }

  loadTagSkipStates();

  // Tag menu items - declare before functions that use them
  let tagMenuItems: Spicetify.Menu.Item[] = [];
  let tagSubMenu: Spicetify.Menu.SubMenu;

  // Ban list updater
  async function updateBanList(force: Boolean) {
    const now = Date.now();
    const lastFetchStr = Spicetify.LocalStorage.get(CONFIG.timeKey);
    const lastFetch = lastFetchStr ? parseInt(lastFetchStr) : 0;
    const cachedList = Spicetify.LocalStorage.get(CONFIG.cacheKey);
    let data: any[] = [];

    // If cache exists, load it first
    if (cachedList && force) {
      try {
        data = JSON.parse(cachedList);
      } catch (e) {
        console.error("[AI Blocker] Cache parse error", e);
      }
    }

    // If cache is old or empty, fetch new data
    if (force || now - lastFetch > CONFIG.ttl || data.length === 0) {
      console.log("[AI Blocker] Fetching new blocklist...");
      try {
        const res = await fetch(CONFIG.url);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);

        data = await res.json();

        if (data.length > 0) {
          Spicetify.LocalStorage.set(CONFIG.cacheKey, JSON.stringify(data));
          Spicetify.LocalStorage.set(CONFIG.timeKey, now.toString());
          console.log(`[AI Blocker] Updated cache with ${data.length} artists.`);
        }
      } catch (error) {
        console.error("[AI Blocker] Fetch failed, using cached data if available.", error);
      }
    }

    // Process data to extract artist names and tags
    artistData.clear();
    const discoveredTags = new Set<string>();

    for (const item of data) {
      let artistName: string;
      let tags: string[] = [];

      if (typeof item === "string") {
        artistName = item;
      } else if (typeof item === "object" && item.name) {
        artistName = item.name;
        tags = Array.isArray(item.tags) ? item.tags : [];
      } else {
        continue;
      }

      const normalizedName = artistName.toLowerCase().trim();
      artistData.set(normalizedName, tags);

      // Collect all tags
      for (const tag of tags) {
        discoveredTags.add(tag);
      }
    }

    // Initialize any new tags with default skip state (true)
    let newTagsFound = false;
    for (const tag of discoveredTags) {
      if (!tagSkipStates.has(tag)) {
        tagSkipStates.set(tag, true); // Default to skipping
        newTagsFound = true;
      }
    }

    if (newTagsFound) {
      saveTagSkipStates();
      updateTagMenuItems();
    }
  }
  await updateBanList(false);

  // Schedule periodic updates of the ban list
  updateIntervalId = setInterval(() => {
    console.log("[AI Blocker] Running scheduled ban list update...");
    updateBanList(false);
  }, CONFIG.ttl);

  function updateTagMenuItems() {
    // Clear existing tag menu items
    tagMenuItems = [];

    // Sort tags alphabetically
    const sortedTags = Array.from(tagSkipStates.keys()).sort();

    for (const tag of sortedTags) {
      const isSkipped = tagSkipStates.get(tag) ?? true;
      const menuItem = new Spicetify.Menu.Item(
        `Skip: ${tag}`,
        isSkipped,
        (item) => {
          const newState = !tagSkipStates.get(tag);
          tagSkipStates.set(tag, newState);
          saveTagSkipStates();
          item.setState(newState);
          Spicetify.showNotification(`Tag "${tag}" ${newState ? "will be skipped" : "allowed"}`);

          if (newState && isEnabled) checkTrack();
        }
      );
      tagMenuItems.push(menuItem);
    }

    // Update the submenu if it exists
    if (tagSubMenu) {
      tagSubMenu.deregister();
      tagSubMenu = new Spicetify.Menu.SubMenu("AI Filter Tags", tagMenuItems);
      tagSubMenu.register();
    }
  }

  // Initialize tag menu items
  updateTagMenuItems();
  tagSubMenu = new Spicetify.Menu.SubMenu("AI Filter Tags", tagMenuItems);

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

  const updateBlocklistButton = new Spicetify.Menu.Item(
    "Update Blocklist",
    false,
    async () => {
      Spicetify.showNotification("Updating blocklist...");
      await updateBanList(true);
      await sleep(200);
      Spicetify.showNotification("Blocklist updated successfully!");
    }
  );

  // Create flyout menu
  const flyoutMenu = new Spicetify.Menu.SubMenu("AI Band Blocker", [
    enableToggle,
    allowLikedToggle,
    updateBlocklistButton,
  ]);
  flyoutMenu.register();

  // Register tag submenu separately
  tagSubMenu.register();

  // Song checker
  async function checkTrack() {
    if (!isEnabled) return;

    const data = Spicetify.Player.data;
    // Guard clauses for missing data
    if (!data || !data.item || !data.item.artists) return;
    console.log("[AI Blocker] Current track artists: ", data.item.artists);

    // Check every artist on the current track
    const trackArtists = data.item.artists.map((a: any) => a.name.toLowerCase().trim());

    // Find if any artist is in our database and check their tags
    for (const artist of trackArtists) {
      if (artistData.has(artist)) {
        const artistTags = artistData.get(artist) || [];

        // If artist has no tags, skip by default
        if (artistTags.length === 0) {
          if (!Spicetify.Player.isPlaying()) return;

          // Check if song is liked and we should allow it
          if (allowLikedSongs) {
            const trackUri = data.item.uri;
            if (trackUri) {
              try {
                const isLiked = await Spicetify.Platform.LibraryAPI.contains(trackUri);
                if (isLiked) {
                  console.log(`[AI Blocker] Detected AI Artist: ${artist}, but song is liked. Allowing...`);
                  return;
                }
              } catch (error) {
                console.error("[AI Blocker] Error checking if song is liked:", error);
              }
            }
          }

          console.log(`[AI Blocker] Detected AI Artist with no tags: ${artist}. Skipping...`);
          Spicetify.Player.next();
          Spicetify.showNotification(`Skipped AI Band: ${artist.toUpperCase()}`);
          return;
        }

        // Check if any of the artist's tags are marked for skipping
        const hasSkippableTag = artistTags.some(tag => tagSkipStates.get(tag) === true);

        if (hasSkippableTag) {
          if (!Spicetify.Player.isPlaying()) return;

          // Check if song is liked and we should allow it
          if (allowLikedSongs) {
            const trackUri = data.item.uri;
            if (trackUri) {
              try {
                const isLiked = await Spicetify.Platform.LibraryAPI.contains(trackUri);
                if (isLiked) {
                  const skippableTags = artistTags.filter(tag => tagSkipStates.get(tag) === true);
                  console.log(`[AI Blocker] Detected AI Artist: ${artist} with skippable tags: ${skippableTags.join(", ")}, but song is liked. Allowing...`);
                  return;
                }
              } catch (error) {
                console.error("[AI Blocker] Error checking if song is liked:", error);
              }
            }
          }

          const skippableTags = artistTags.filter(tag => tagSkipStates.get(tag) === true);
          console.log(`[AI Blocker] Detected AI Artist: ${artist} with skippable tags: ${skippableTags.join(", ")}. Skipping...`);
          Spicetify.Player.next();
          Spicetify.showNotification(`Skipped AI Band: ${artist.toUpperCase()} (${skippableTags.join(", ")})`);
          return;
        }
      }
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