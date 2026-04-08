async function main() {
  // 1. Wait for Spicetify global API to be ready
  while (!Spicetify?.Player || !Spicetify?.Menu || !Spicetify?.LocalStorage) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const CONFIG = {
    url: "https://raw.githubusercontent.com/xoundbyte/soul-over-ai/main/dist/artists.json",
    zoundhubSearchUrl: "https://ellqnfjepuncnaveguzv.supabase.co/rest/v1/rpc/search_artists",
    zoundhubSearchApiKey: "sb_publishable_AARag97tZVJl4vaeD1O_LQ_gjsnn0P9",
    cacheKey: "ai-bands:list",
    enabledKey: "ai-bands:enabled",
    allowLikedKey: "ai-bands:allowLiked",
    tagSkipStatesKey: "ai-bands:tagSkipStates",
    showAITagsKey: "ai-bands:showAITags",
    labelAISongsKey: "ai-bands:labelAISongs",
    zoundhubFallbackEnabledKey: "ai-bands:zoundhubFallbackEnabled",
    zoundhubThresholdKey: "ai-bands:zoundhubThreshold",
  };
  const ZOUNDHUB_THRESHOLD_OPTIONS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

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
  let artistData: Map<string, string[]> = new Map(); // artist ID -> tags
  let artistNames: Map<string, string> = new Map(); // artist ID -> display name (for notifications)
  let tagSkipStates: Map<string, boolean> = new Map(); // tag -> should skip
  let validTags: Set<string> = new Set(); // tags that exist in the current blocklist
  let isEnabled = Spicetify.LocalStorage.get(CONFIG.enabledKey) !== "false"; // Default to true
  let allowLikedSongs = Spicetify.LocalStorage.get(CONFIG.allowLikedKey) === "true";
  let showAITags = Spicetify.LocalStorage.get(CONFIG.showAITagsKey) !== "false"; // For tagging AI artists -  Default to true
  let labelAISongs = Spicetify.LocalStorage.get(CONFIG.labelAISongsKey) !== "false"; // Default to true
  let zoundhubFallbackEnabled = Spicetify.LocalStorage.get(CONFIG.zoundhubFallbackEnabledKey) !== "false";
  const storedZoundhubThresholdRaw = Spicetify.LocalStorage.get(CONFIG.zoundhubThresholdKey);
  const storedZoundhubThreshold = storedZoundhubThresholdRaw !== null ? Number(storedZoundhubThresholdRaw) : Number.NaN;
  let zoundhubThreshold = ZOUNDHUB_THRESHOLD_OPTIONS.includes(storedZoundhubThreshold) ? storedZoundhubThreshold : 80;
  let aiTagObserver: MutationObserver | null = null;
  let zoundhubFallbackCache: Map<string, { isAI: boolean; score: number | null }> = new Map();

  if (!ZOUNDHUB_THRESHOLD_OPTIONS.includes(storedZoundhubThreshold)) {
    Spicetify.LocalStorage.set(CONFIG.zoundhubThresholdKey, zoundhubThreshold.toString());
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

  type ZoundhubArtistMatch = {
    slug: string;
    name: string;
  };

  type ZoundhubTrackScore = {
    name: string;
    score: number;
  };

  type ZoundhubAiData = {
    averageScore: number;
    totalTracksAnalyzed: number;
    tracks: ZoundhubTrackScore[];
  };

  async function lookupZoundhubArtistBySpotifyId(artistName: string, spotifyId: string): Promise<ZoundhubArtistMatch | null> {
    const response = await fetch(CONFIG.zoundhubSearchUrl, {
      headers: {
        accept: "*/*",
        apikey: CONFIG.zoundhubSearchApiKey,
        "content-profile": "public",
        "content-type": "application/json",
      },
      body: JSON.stringify({ search_query: artistName }),
      method: "POST",
      mode: "cors",
      credentials: "omit",
    });

    if (!response.ok) {
      throw new Error(`[AI Blocker] Zoundhub search failed with status ${response.status}`);
    }

    const rawResults: unknown = await response.json();
    if (!Array.isArray(rawResults)) return null;

    const match = rawResults.find((entity) => {
      if (typeof entity !== "object" || entity === null) return false;
      const spotifyIdCandidate = (entity as { spotify_id?: unknown; spotifyId?: unknown }).spotify_id
        ?? (entity as { spotify_id?: unknown; spotifyId?: unknown }).spotifyId;
      const slug = (entity as { slug?: unknown }).slug;

      return spotifyIdCandidate === spotifyId && typeof slug === "string" && slug.length > 0;
    }) as { slug?: unknown; name?: unknown } | undefined;

    if (!match || typeof match.slug !== "string") return null;

    return {
      slug: match.slug,
      name: typeof match.name === "string" && match.name.trim() ? match.name : artistName,
    };
  }

  function findArtistData(obj: unknown): { submithub?: unknown; deezer?: unknown } | null {
    if (typeof obj !== "object" || obj === null) return null;

    const asRecord = obj as Record<string, unknown>;
    if (typeof asRecord.artist === "object" && asRecord.artist !== null) {
      const artistRecord = asRecord.artist as Record<string, unknown>;
      if (artistRecord.submithub !== undefined) {
        return {
          submithub: artistRecord.submithub,
          deezer: artistRecord.deezer,
        };
      }
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        const result = findArtistData(item);
        if (result) return result;
      }
    } else {
      for (const value of Object.values(asRecord)) {
        const result = findArtistData(value);
        if (result) return result;
      }
    }

    return null;
  }

  function extractZoundhubAiData(artistData: { submithub?: unknown; deezer?: unknown }): ZoundhubAiData | null {
    const tracksRaw = Array.isArray(artistData.submithub) ? artistData.submithub : [];
    const tracks = tracksRaw
      .map((track) => {
        if (typeof track !== "object" || track === null) return null;

        const trackRecord = track as Record<string, unknown>;
        const score = trackRecord.score;
        const name = trackRecord.name;

        if (typeof score !== "number" || Number.isNaN(score)) return null;

        return {
          name: typeof name === "string" ? name : "Unknown",
          score,
        } as ZoundhubTrackScore;
      })
      .filter((track): track is ZoundhubTrackScore => track !== null);

    if (tracks.length === 0) {
      return {
        averageScore: 0,
        totalTracksAnalyzed: 0,
        tracks,
      };
    }

    const totalScore = tracks.reduce((sum, track) => sum + track.score, 0);
    const averageScore = totalScore / tracks.length;

    return {
      averageScore,
      totalTracksAnalyzed: tracks.length,
      tracks,
    };
  }

  function parseRscForAiScores(rscPayload: string): ZoundhubAiData | null {
    const lines = rscPayload.split("\n");

    for (const line of lines) {
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) continue;

      const dataString = line.substring(colonIndex + 1);
      if (!dataString.startsWith("{") && !dataString.startsWith("[")) continue;

      try {
        const parsedJson = JSON.parse(dataString);
        const artistData = findArtistData(parsedJson);

        if (artistData) {
          return extractZoundhubAiData(artistData);
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  async function getZoundhubAiDataForSlug(slug: string): Promise<ZoundhubAiData | null> {
    const response = await fetch(`https://zoundhub.com/artist/${encodeURIComponent(slug)}`, {
      headers: {
        accept: "*/*",
        "cache-control": "no-cache",
        pragma: "no-cache",
        rsc: "1",
      },
      method: "GET",
      mode: "cors",
      credentials: "omit",
    });

    if (!response.ok) {
      throw new Error(`[AI Blocker] Zoundhub artist payload failed with status ${response.status}`);
    }

    const rscText = await response.text();
    return parseRscForAiScores(rscText);
  }

  async function isArtistAIViaZoundhubFallback(artistId: string, artistName: string): Promise<{ isAI: boolean; score: number | null }> {
    const cached = zoundhubFallbackCache.get(artistId);
    if (cached) return cached;

    const notAIResult = { isAI: false, score: null };

    if (!artistName.trim()) {
      zoundhubFallbackCache.set(artistId, notAIResult);
      return notAIResult;
    }

    try {
      const artistMatch = await lookupZoundhubArtistBySpotifyId(artistName, artistId);
      if (!artistMatch) {
        zoundhubFallbackCache.set(artistId, notAIResult);
        return notAIResult;
      }

      const aiData = await getZoundhubAiDataForSlug(artistMatch.slug);
      if (!aiData || !Number.isFinite(aiData.averageScore) || aiData.totalTracksAnalyzed <= 0) {
        zoundhubFallbackCache.set(artistId, notAIResult);
        return notAIResult;
      }

      const isAI = aiData.averageScore >= zoundhubThreshold;
      const result = {
        isAI,
        score: aiData.averageScore,
      };

      zoundhubFallbackCache.set(artistId, result);
      return result;
    } catch (error) {
      // Zoundhub may change over time; fail open and treat unknown lookups as non-AI.
      console.warn(`[AI Blocker] Zoundhub fallback lookup failed for ${artistName}:`, error);
      zoundhubFallbackCache.set(artistId, notAIResult);
      return notAIResult;
    }
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

  function parseArtistTags(item: Record<string, unknown>): string[] {
    const tagsRaw = Array.isArray(item.tags)
      ? item.tags
      : Array.isArray(item.markers)
        ? item.markers
        : [];

    return tagsRaw.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0);
  }

  // AI Tag Injection Functions
  function isArtistAI(artistId: string): boolean {
    return artistData.has(artistId);
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
        const artistName = artistNames.get(artistId);

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
  let zoundhubConfidenceMenuItems: Spicetify.Menu.Item[] = [];
  let zoundhubConfidenceSubMenu: Spicetify.Menu.SubMenu;

  // Ban list updater
  async function updateBanList() {
    const cachedList = Spicetify.LocalStorage.get(CONFIG.cacheKey);
    let data: any[] = [];

    // If cache exists, load it first
    if (cachedList) {
      try {
        data = JSON.parse(cachedList);
      } catch (e) {
        console.error("[AI Blocker] Cache parse error", e);
      }
    }

    // Fetch blocklist only when there is no usable cache.
    if (data.length === 0) {
      console.log("[AI Blocker] Fetching new blocklist...");
      try {
        const res = await fetch(CONFIG.url);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);

        data = await res.json();

        if (data.length > 0) {
          Spicetify.LocalStorage.set(CONFIG.cacheKey, JSON.stringify(data));
          console.log(`[AI Blocker] Updated cache with ${data.length} artists.`);
        }
      } catch (error) {
        console.error("[AI Blocker] Fetch failed, using cached data if available.", error);
      }
    }

    // Process data to extract artist IDs and tags
    artistData.clear();
    artistNames.clear();
    const discoveredTags = new Set<string>();

    for (const item of data) {
      let artistName: string;
      let tags: string[] = [];
      let spotifyUrl: string | null = null;

      if (typeof item === "string") {
        // Legacy format: just a name string (no ID available, skip)
        continue;
      } else if (typeof item === "object" && item !== null && "name" in item) {
        const itemRecord = item as Record<string, unknown>;

        if (itemRecord.removed === true) {
          continue;
        }

        if (typeof itemRecord.name !== "string" || !itemRecord.name.trim()) {
          continue;
        }

        artistName = itemRecord.name;
        tags = parseArtistTags(itemRecord);

        if (typeof itemRecord.spotify === "string") {
          spotifyUrl = itemRecord.spotify;
        } else if (typeof itemRecord.spotifyId === "string") {
          spotifyUrl = itemRecord.spotifyId;
        }
      } else {
        continue;
      }

      // Extract Spotify artist ID
      const artistId = extractArtistId(spotifyUrl);
      if (!artistId) {
        // No valid Spotify ID, skip this artist
        continue;
      }

      artistData.set(artistId, tags);
      artistNames.set(artistId, artistName);

      // Collect all tags
      for (const tag of tags) {
        discoveredTags.add(tag);
      }
    }

    // Update validTags with currently discovered tags
    validTags = discoveredTags;

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
    }

    // Update menu
    updateTagMenuItems();

    // Re-inject AI tags if they're enabled (to catch new artists from updated list)
    if (showAITags) {
      removeAllAITags();
      removeAllAILabels();
      injectAITags();
    }
  }
  await updateBanList();

  function updateTagMenuItems() {
    // Clear existing tag menu items
    tagMenuItems = [];

    // Sort tags alphabetically
    const sortedTags = Array.from(tagSkipStates.keys())
      .filter(tag => validTags.has(tag))
      .sort();

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

  function updateZoundhubConfidenceMenuItems() {
    zoundhubConfidenceMenuItems = [];

    for (const thresholdOption of ZOUNDHUB_THRESHOLD_OPTIONS) {
      const menuItem = new Spicetify.Menu.Item(
        `${thresholdOption}%`,
        zoundhubThreshold === thresholdOption,
        (item) => {
          if (zoundhubThreshold === thresholdOption) {
            item.setState(true);
            return;
          }

          zoundhubThreshold = thresholdOption;
          Spicetify.LocalStorage.set(CONFIG.zoundhubThresholdKey, zoundhubThreshold.toString());
          zoundhubFallbackCache.clear();
          updateZoundhubConfidenceMenuItems();
          Spicetify.showNotification(`Zoundhub confidence set to ${zoundhubThreshold}%`);

          if (isEnabled) {
            checkTrack();
          }
        }
      );

      zoundhubConfidenceMenuItems.push(menuItem);
    }

    if (zoundhubConfidenceSubMenu) {
      zoundhubConfidenceSubMenu.deregister();
      zoundhubConfidenceSubMenu = new Spicetify.Menu.SubMenu(
        `Zoundhub confidence (${zoundhubThreshold}%)`,
        zoundhubConfidenceMenuItems
      );
      zoundhubConfidenceSubMenu.register();
    }
  }

  // Initialize tag menu items
  updateTagMenuItems();
  updateZoundhubConfidenceMenuItems();
  tagSubMenu = new Spicetify.Menu.SubMenu("AI Filter Tags", tagMenuItems);
  zoundhubConfidenceSubMenu = new Spicetify.Menu.SubMenu(
    `Zoundhub confidence (${zoundhubThreshold}%)`,
    zoundhubConfidenceMenuItems
  );

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

  const zoundhubFallbackToggle = new Spicetify.Menu.Item(
    "Zoundhub fallback",
    zoundhubFallbackEnabled,
    (menuItem) => {
      zoundhubFallbackEnabled = !zoundhubFallbackEnabled;
      Spicetify.LocalStorage.set(CONFIG.zoundhubFallbackEnabledKey, zoundhubFallbackEnabled.toString());
      menuItem.setState(zoundhubFallbackEnabled);
      zoundhubFallbackCache.clear();
      Spicetify.showNotification(`Zoundhub fallback ${zoundhubFallbackEnabled ? "ON" : "OFF"}`);
    }
  );

  // Create flyout menu
  const flyoutMenu = new Spicetify.Menu.SubMenu("AI Band Blocker", [
    enableToggle,
    allowLikedToggle,
    showAITagsToggle,
    labelAISongsToggle,
    zoundhubFallbackToggle,
  ]);
  flyoutMenu.register();

  // Register tag submenu separately
  tagSubMenu.register();
  zoundhubConfidenceSubMenu.register();

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
      const artistUri = (artistObj as any).uri;
      const artistId = extractArtistId(artistUri);
      const artistDisplayName = artistNames.get(artistId || '') || (artistObj as any).name || 'Unknown';

      if (!artistId) continue;

      if (!artistData.has(artistId)) {
        if (!zoundhubFallbackEnabled) {
          continue;
        }

        const fallbackResult = await isArtistAIViaZoundhubFallback(artistId, (artistObj as any).name || artistDisplayName);
        if (!fallbackResult.isAI) continue;

        if (!Spicetify.Player.isPlaying()) return;

        if (await shouldAllowTrackBecauseLiked(trackUri)) {
          console.log(`[AI Blocker] Zoundhub fallback flagged ${artistDisplayName}, but track is liked. Allowing...`);
          return;
        }

        const scoreSuffix = fallbackResult.score !== null
          ? ` (${fallbackResult.score.toFixed(1)}% AI via Zoundhub)`
          : " (AI via Zoundhub)";

        console.log(`[AI Blocker] Zoundhub fallback flagged ${artistDisplayName}${scoreSuffix}. Skipping...`);
        Spicetify.Player.next();
        Spicetify.showNotification(`Skipped AI Band: ${artistDisplayName.toUpperCase()}${scoreSuffix}`);
        return;
      }

      const artistTags = artistData.get(artistId) || [];

      // If artist has no tags, skip by default
      if (artistTags.length === 0) {
        if (!Spicetify.Player.isPlaying()) return;

        // Check if song is liked and we should allow it
        if (await shouldAllowTrackBecauseLiked(trackUri)) {
          console.log(`[AI Blocker] Detected AI Artist: ${artistDisplayName}, but song is liked. Allowing...`);
          return;
        }

        console.log(`[AI Blocker] Detected AI Artist with no tags: ${artistDisplayName}. Skipping...`);
        Spicetify.Player.next();
        Spicetify.showNotification(`Skipped AI Band: ${artistDisplayName.toUpperCase()}`);
        return;
      }

      // Check if any of the artist's tags are marked for skipping
      const hasSkippableTag = artistTags.some(tag => tagSkipStates.get(tag) === true);

      if (hasSkippableTag) {
        if (!Spicetify.Player.isPlaying()) return;

        // Check if song is liked and we should allow it
        if (await shouldAllowTrackBecauseLiked(trackUri)) {
          const skippableTags = artistTags.filter(tag => tagSkipStates.get(tag) === true);
          console.log(`[AI Blocker] Detected AI Artist: ${artistDisplayName} with skippable tags: ${skippableTags.join(", ")}, but song is liked. Allowing...`);
          return;
        }

        const skippableTags = artistTags.filter(tag => tagSkipStates.get(tag) === true);
        console.log(`[AI Blocker] Detected AI Artist: ${artistDisplayName} with skippable tags: ${skippableTags.join(", ")}. Skipping...`);
        Spicetify.Player.next();
        Spicetify.showNotification(`Skipped AI Band: ${artistDisplayName.toUpperCase()} (${skippableTags.join(", ")})`);
        return;
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