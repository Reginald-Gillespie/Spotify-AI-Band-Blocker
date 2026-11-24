async function main() {
  // 1. Wait for Spicetify global API to be ready
  while (!Spicetify?.Player || !Spicetify?.Menu || !Spicetify?.LocalStorage) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const CONFIG = {
    url: "https://zoundhub.com/data/artists-all.json",
    cacheKey: "ai-bands:zoundhubList",
    cacheTimeKey: "ai-bands:zoundhubListFetchedAt",
    cacheMaxAgeMs: 12 * 60 * 60 * 1000, // Refresh the export every 12 hours
    enabledKey: "ai-bands:enabled",
    allowLikedKey: "ai-bands:allowLiked",
    showAITagsKey: "ai-bands:showAITags",
    labelAISongsKey: "ai-bands:labelAISongs",
    thresholdKey: "ai-bands:zoundhubThreshold",
  };
  const THRESHOLD_OPTIONS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  // Clean up storage left by older versions (SoulOverAI list, tag filters, per-artist lookup fallback)
  for (const legacyKey of ["ai-bands:list", "ai-bands:tagSkipStates", "ai-bands:zoundhubFallbackEnabled"]) {
    Spicetify.LocalStorage.remove(legacyKey);
  }

  // CSS for AI tags
  const aiTagStyles = document.createElement("style");
  aiTagStyles.textContent = `
    .ai-band-tag {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background-color: #5bcefa;
      color: #000;
      font-size: 10px;
      font-weight: 700;
      padding: 2px 5px;
      border-radius: 3px;
      margin-left: 4px;
      vertical-align: middle;
      line-height: 1;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .ai-band-tag-header {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background-color: #5bcefa;
      color: #000;
      font-size: 24px;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 6px;
      margin-left: 12px;
      vertical-align: middle;
      line-height: 1;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      position: relative;
      z-index: 10;
    }
    .ai-song-label {
      color: #5bcefa !important;
      font-size: 11px;
      font-weight: 600;
      margin-left: 8px;
      white-space: nowrap;
    }
  `;
  document.head.appendChild(aiTagStyles);

  let timeoutId: NodeJS.Timeout;
  type ArtistEntry = { name: string; score: number | null };
  let artistData: Map<string, ArtistEntry> = new Map(); // Spotify artist ID -> Zoundhub entry
  let isEnabled = Spicetify.LocalStorage.get(CONFIG.enabledKey) !== "false"; // Default to true
  let allowLikedSongs = Spicetify.LocalStorage.get(CONFIG.allowLikedKey) === "true";
  let showAITags = Spicetify.LocalStorage.get(CONFIG.showAITagsKey) !== "false"; // For tagging AI artists -  Default to true
  let labelAISongs = Spicetify.LocalStorage.get(CONFIG.labelAISongsKey) !== "false"; // Default to true
  const storedThresholdRaw = Spicetify.LocalStorage.get(CONFIG.thresholdKey);
  const storedThreshold = storedThresholdRaw !== null ? Number(storedThresholdRaw) : Number.NaN;
  let threshold = THRESHOLD_OPTIONS.includes(storedThreshold) ? storedThreshold : 80;
  let aiTagObserver: MutationObserver | null = null;

  if (!THRESHOLD_OPTIONS.includes(storedThreshold)) {
    Spicetify.LocalStorage.set(CONFIG.thresholdKey, threshold.toString());
  }

  function extractArtistId(spotifyUrl: string | null | undefined): string | null {
    if (!spotifyUrl) return null;

    const trimmed = spotifyUrl.trim();

    // Accept raw 22-char Spotify IDs as well as URLs/URIs
    const directIdMatch = trimmed.match(/^[a-zA-Z0-9]{22}$/);
    if (directIdMatch) {
      return directIdMatch[0];
    }

    // Handle both URLs like https://open.spotify.com/artist/ID and URIs like spotify:artist:ID
    const urlMatch = trimmed.match(/artist[\/:]([a-zA-Z0-9]+)/);
    return urlMatch ? urlMatch[1] : null;
  }

  async function shouldAllowTrackBecauseLiked(trackUri: string | undefined): Promise<boolean> {
    if (!allowLikedSongs || !trackUri) return false;

    try {
      return await Spicetify.Platform.LibraryAPI.contains(trackUri);
    } catch (error) {
      console.error("[AI Blocker] Error checking if song is liked:", error);
      return false;
    }
  }

  // AI Tag Injection Functions
  // An artist counts as AI when Zoundhub's score meets the user's confidence threshold.
  // Artists without a score are treated as not-AI (fail open).
  function getAIArtist(artistId: string): ArtistEntry | null {
    const entry = artistData.get(artistId);
    if (!entry || entry.score === null || entry.score < threshold) return null;
    return entry;
  }

  function isArtistAI(artistId: string): boolean {
    return getAIArtist(artistId) !== null;
  }

  // Used to label AI artists
  function createAITag(): HTMLSpanElement {
    const tag = document.createElement("span");
    tag.className = "ai-band-tag";
    tag.textContent = "AI";
    tag.setAttribute("data-ai-tag", "true");
    return tag;
  }

  // Used to label AI songs
  function createAISongLabel(): HTMLSpanElement {
    const label = document.createElement("span");
    label.className = "ai-song-label";
    label.textContent = "AI Artist";
    label.setAttribute("data-ai-song-label", "true");
    label.style.flexShrink = "0";
    return label;
  }

  // Run various scans for where to inject AI tags on artists
  function injectAITags() {
    if (!showAITags) return;

    // Find all artist links in the document
    const artistLinks = document.querySelectorAll('a[href*="/artist/"]');

    // Determine current artist ID from "Show All" buttons to put label on profile page
    let currentArtistId: string | null = null;
    const allLinks = Array.from(document.querySelectorAll('a[href*="/artist/"]'));

    for (const link of allLinks) {
      if (link.textContent?.trim().toLowerCase() === 'show all') {
        const id = extractArtistId((link as HTMLAnchorElement).href);
        if (id) {
          currentArtistId = id;
          break;
        }
      }
    }

    // Label everything that links to AI artists
    artistLinks.forEach((link) => {
      const linkEl = link as HTMLAnchorElement;

      // Get artist ID from the href
      const artistId = extractArtistId(linkEl.href);
      if (!artistId) return;

      // Check for existing tags
      const existingTag = link.querySelector('.ai-band-tag');
      const existingNextSiblingTag = link.nextElementSibling?.classList?.contains('ai-band-tag') 
        ? link.nextElementSibling 
        : null;

      // Check if this artist is AI
      if (isArtistAI(artistId)) {
        // Skip if already tagged
        if (existingTag || existingNextSiblingTag) {
          return;
        }
        const artistName = artistData.get(artistId)?.name;

        // Get the first base child of the linkEl to make sure we're just extracting the name
        //   as opposed to "verified artist" text etc.
        let nameEl: ChildNode =  linkEl;
        let recursionLimit = 15; // Prevent infinite loops
        while (--recursionLimit && nameEl.childNodes[0]) {
          nameEl = nameEl.childNodes[0];
        }
        
        const linkText = (nameEl as HTMLElement).textContent?.trim() || "";

        // Blacklist specific artist link buttons
        if (/Discovered On|Discovery|You've liked|Show all/i.test(linkText)) {
          return;
        }

        // Only tag if the link text matches the artist name
        if (artistName && linkText.toLowerCase() !== artistName.toLowerCase()) {
          return;
        }

        // Create and insert the AI tag after the link text
        const tag = createAITag();

        // Artist names in search bar
        if (
          nameEl?.parentElement?.parentElement?.dataset.encoreId == 'listRowTitle' &&
          nameEl?.parentElement?.parentElement?.parentElement?.tagName.toLowerCase() === "a"
        ) {
          // Change style of name block to put AI tag inline
          nameEl.parentElement.parentElement.parentElement.style.display = "inline-flex";
          link.appendChild(tag);
        }
        // Check if we should append inside or after the link
        // For inline artist names, we append inside to keep styling consistent
        else if (link.parentElement?.classList?.contains('encore-text') ||
          link.closest('[data-testid="tracklist-row"]') ||
          link.closest('[data-testid="track-row"]') ||
          link.closest('.main-trackList-trackListRow')) {
          link.parentElement?.insertBefore(tag, link.nextSibling);
        }
        // Default for any other type of link 
        else {
          link.appendChild(tag);
        }
      } else {
        // Artist is NOT AI - remove any existing tags
        if (existingTag) {
          existingTag.remove();
        }
        if (existingNextSiblingTag) {
          existingNextSiblingTag.remove();
        }
      }
    });

    // Handle artist profile page header
    // The artist name in the header is typically in an h1 element
    const artistPageHeader = document.querySelector('.main-entityHeader-title h1, .main-entityHeader-title');


    if (artistPageHeader && !artistPageHeader.querySelector('.ai-band-tag') && !artistPageHeader.querySelector('.ai-band-tag-header')) {
      if (currentArtistId && isArtistAI(currentArtistId)) {
        const tag = createAITag();
        tag.classList.remove('ai-band-tag');
        tag.classList.add('ai-band-tag-header');

        artistPageHeader.appendChild(tag);

        // Style the container
        artistPageHeader.style.marginBottom = '12px';
        artistPageHeader.style.display = 'flex';
        artistPageHeader.style.flexWrap = 'wrap';
        artistPageHeader.style.alignItems = 'center';
        artistPageHeader.style.gap = '12px';

        // Scale down the title
        const titleSpan = artistPageHeader.querySelector('[data-encore-id="adaptiveTitle"]');
        if (titleSpan) {
          const currentSize = parseFloat(titleSpan.style.fontSize) || 96;
          titleSpan.style.fontSize = (currentSize * 0.85) + 'px'; // Scale to 85%
        }
      }
    }

    // Label songs by AI artists
    if (labelAISongs) {
      labelAISongRows();
    }
  }

  // Scans for AI songs, called after injectAITags scan
  function labelAISongRows() {
    // Find track rows in playlists, albums, search results, etc.
    const trackRows = document.querySelectorAll(
      '[data-testid="tracklist-row"], ' +
      '[data-testid="track-row"], ' +
      '.main-trackList-trackListRow, ' +
      '[role="row"][aria-rowindex]'
    );

    trackRows.forEach((row) => {
      // Skip if already labeled
      if (row.querySelector('.ai-song-label')) {
        return;
      }

      // Find artist links in this row
      const artistLinks = row.querySelectorAll('a[href*="/artist/"]');
      let hasAIArtist = false;

      let aiArtistIDs = new Set<string>();

      artistLinks.forEach((link) => {
        const linkEl = link as HTMLAnchorElement;
        const artistId = extractArtistId(linkEl.href);
        if (artistId && isArtistAI(artistId)) {
          artistId && aiArtistIDs.add(artistId);
          hasAIArtist = true;
        }
      });

      if (hasAIArtist) {
        // Inject playlist view
        const mainContent = row.querySelector(".main-trackList-rowMainContent");
        const nameDiv = mainContent?.querySelector(".encore-text-body-medium");
        if (nameDiv && mainContent) {
          // Create a wrapper div for name and label
          const wrapper = document.createElement("div");
          wrapper.style.display = "flex";
          wrapper.style.alignItems = "center";

          const label = createAISongLabel();
          const nameClone = nameDiv.cloneNode(true) as HTMLElement;

          wrapper.appendChild(nameClone);
          wrapper.appendChild(label);
          nameDiv.replaceWith(wrapper);
          return;
        }
      }
    });
  }

  function removeAllAILabels() {
    document.querySelectorAll('.ai-band-tag, .ai-song-label').forEach(el => el.remove());
  }

  function removeAllAITags() {
    document.querySelectorAll('.ai-band-tag').forEach(tag => tag.remove());
  }

  function removeAllAISongLabels() {
    document.querySelectorAll('.ai-song-label').forEach(label => label.remove());
  }

  function startAITagObserver() {
    if (aiTagObserver) {
      aiTagObserver.disconnect();
    }

    // Debounce the injection to avoid excessive DOM operations
    let debounceTimeout: NodeJS.Timeout | null = null;

    aiTagObserver = new MutationObserver(() => {
      if (debounceTimeout) {
        clearTimeout(debounceTimeout);
      }
      debounceTimeout = setTimeout(() => {
        injectAITags();
      }, 100);
    });

    // Observe the entire document for changes
    aiTagObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Initial injection
    injectAITags();
  }

  function stopAITagObserver() {
    if (aiTagObserver) {
      aiTagObserver.disconnect();
      aiTagObserver = null;
    }
    removeAllAITags();
    removeAllAILabels();
  }

  let confidenceMenuItems: Spicetify.Menu.Item[] = [];
  let confidenceSubMenu: Spicetify.Menu.SubMenu;

  function applyArtistList(artists: unknown[]) {
    artistData.clear();

    for (const item of artists) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;

      const artistId = extractArtistId(typeof record.id === "string" ? record.id : null);
      if (!artistId) continue;

      const name = typeof record.name === "string" ? record.name : "";
      const score = typeof record.sh_score === "number" && Number.isFinite(record.sh_score) ? record.sh_score : null;
      artistData.set(artistId, { name, score });
    }
  }

  function loadCachedArtistList(): unknown[] | null {
    const cached = Spicetify.LocalStorage.get(CONFIG.cacheKey);
    if (!cached) return null;
    try {
      const parsed = JSON.parse(cached);
      return Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      console.error("[AI Blocker] Cache parse error", e);
      return null;
    }
  }

  function refreshLabels() {
    if (!showAITags) return;
    removeAllAILabels();
    injectAITags();
  }

  // Zoundhub doesn't send CORS headers, so a plain fetch from the Spotify client is blocked.
  // CosmosAsync routes the request through Spotify's native networking, which isn't subject to CORS.
  async function fetchExport(): Promise<unknown> {
    try {
      const res = await fetch(CONFIG.url);
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    } catch (error) {
      console.log("[AI Blocker] Direct fetch failed, retrying via CosmosAsync.", error);
    }

    const body = await Spicetify.CosmosAsync.get(CONFIG.url);
    return typeof body === "string" ? JSON.parse(body) : body;
  }

  // Ban list updater: uses the cached Zoundhub export, refetching once it is stale
  async function updateBanList() {
    const cachedList = loadCachedArtistList();
    if (cachedList) applyArtistList(cachedList);

    const fetchedAt = Number(Spicetify.LocalStorage.get(CONFIG.cacheTimeKey));
    const isStale = !cachedList || !Number.isFinite(fetchedAt) || Date.now() - fetchedAt > CONFIG.cacheMaxAgeMs;

    if (isStale) {
      console.log("[AI Blocker] Fetching Zoundhub artist export...");
      try {
        const data = await fetchExport();
        const artists = (data as { artists?: unknown } | null)?.artists;
        if (!Array.isArray(artists)) throw new Error("Unexpected export format");

        if (artists.length > 0) {
          applyArtistList(artists);
          // Store a compact copy; the full export is too large for LocalStorage
          const compact = Array.from(artistData, ([id, entry]) => ({ id, name: entry.name, sh_score: entry.score }));
          try {
            Spicetify.LocalStorage.set(CONFIG.cacheKey, JSON.stringify(compact));
            Spicetify.LocalStorage.set(CONFIG.cacheTimeKey, Date.now().toString());
          } catch (e) {
            console.error("[AI Blocker] Failed to write cache", e);
          }
          console.log(`[AI Blocker] Loaded ${artistData.size} artists from Zoundhub.`);
        }
      } catch (error) {
        console.error("[AI Blocker] Fetch failed, using cached data if available.", error);
      }
    }

    refreshLabels();
  }
  await updateBanList();
  setInterval(updateBanList, CONFIG.cacheMaxAgeMs);

  function updateConfidenceMenuItems() {
    confidenceMenuItems = [];

    for (const thresholdOption of THRESHOLD_OPTIONS) {
      const menuItem = new Spicetify.Menu.Item(
        `${thresholdOption}%`,
        threshold === thresholdOption,
        (item) => {
          if (threshold === thresholdOption) {
            item.setState(true);
            return;
          }

          threshold = thresholdOption;
          Spicetify.LocalStorage.set(CONFIG.thresholdKey, threshold.toString());
          updateConfidenceMenuItems();
          Spicetify.showNotification(`AI confidence threshold set to ${threshold}%`);

          refreshLabels();
          if (isEnabled) checkTrack();
        }
      );

      confidenceMenuItems.push(menuItem);
    }

    if (confidenceSubMenu) {
      confidenceSubMenu.deregister();
      confidenceSubMenu = new Spicetify.Menu.SubMenu(`AI confidence threshold (${threshold}%)`, confidenceMenuItems);
      confidenceSubMenu.register();
    }
  }

  updateConfidenceMenuItems();
  confidenceSubMenu = new Spicetify.Menu.SubMenu(`AI confidence threshold (${threshold}%)`, confidenceMenuItems);

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

  const showAITagsToggle = new Spicetify.Menu.Item(
    "Label AI Artists",
    showAITags,
    (menuItem) => {
      showAITags = !showAITags;
      Spicetify.LocalStorage.set(CONFIG.showAITagsKey, showAITags.toString());
      menuItem.setState(showAITags);
      Spicetify.showNotification(`AI Tags ${showAITags ? "ON" : "OFF"}`);

      if (showAITags) {
        startAITagObserver();
      } else {
        stopAITagObserver();
      }
    }
  );

  const labelAISongsToggle = new Spicetify.Menu.Item(
    "Label AI Songs",
    labelAISongs,
    (menuItem) => {
      labelAISongs = !labelAISongs;
      Spicetify.LocalStorage.set(CONFIG.labelAISongsKey, labelAISongs.toString());
      menuItem.setState(labelAISongs);
      Spicetify.showNotification(`AI Song Labels ${labelAISongs ? "ON" : "OFF"}`);

      if (labelAISongs) {
        // Re-inject to add song labels
        injectAITags();
      } else {
        // Remove only song labels
        removeAllAISongLabels();
      }
    }
  );

  // Create flyout menu
  const flyoutMenu = new Spicetify.Menu.SubMenu("AI Band Blocker", [
    enableToggle,
    allowLikedToggle,
    showAITagsToggle,
    labelAISongsToggle,
  ]);
  flyoutMenu.register();

  // Register confidence submenu separately
  confidenceSubMenu.register();

  // Start AI tag observer if enabled
  if (showAITags) {
    startAITagObserver();
  }

  // Song checker
  async function checkTrack() {
    if (!isEnabled) return;

    const data = Spicetify.Player.data;
    // Guard clauses for missing data
    if (!data || !data.item || !data.item.artists) return;
    console.log("[AI Blocker] Current track artists: ", data.item.artists);
    const trackUri = data.item.uri;
    const artistsToCheck = data.item.artists.length > 1 ? [data.item.artists[0]] : data.item.artists;

    // For collabs, only evaluate the first listed artist.
    for (const artistObj of artistsToCheck) {
      const artistId = extractArtistId((artistObj as any).uri);
      if (!artistId) continue;

      const aiArtist = getAIArtist(artistId);
      if (!aiArtist) continue;

      if (!Spicetify.Player.isPlaying()) return;

      const artistDisplayName = aiArtist.name || (artistObj as any).name || "Unknown";
      const scoreSuffix = ` (${aiArtist.score!.toFixed(1)}% AI)`;

      // Check if song is liked and we should allow it
      if (await shouldAllowTrackBecauseLiked(trackUri)) {
        console.log(`[AI Blocker] Detected AI Artist: ${artistDisplayName}${scoreSuffix}, but song is liked. Allowing...`);
        return;
      }

      console.log(`[AI Blocker] Detected AI Artist: ${artistDisplayName}${scoreSuffix}. Skipping...`);
      Spicetify.Player.next();
      Spicetify.showNotification(`Skipped AI Band: ${artistDisplayName.toUpperCase()}${scoreSuffix}`);
      return;
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