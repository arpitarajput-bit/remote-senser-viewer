import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import axios from "axios";
import OpenSeadragon from "openseadragon";

const getApiUrl = () => {
  if (typeof window !== "undefined" && window.location.hostname.includes("github.dev")) {
    const hostname = window.location.hostname;
    const backendHostname = hostname.replace(/-\d+\.app\.github\.dev$/, "-8000.app.github.dev");
    return `${window.location.protocol}//${backendHostname}/api`;
  }
  return "http://127.0.0.1:8000/api";
};

const API = getApiUrl();

const TILE_SIZE = 256;

const computeMaxLevel = (width, height) => {
  const maxDim = Math.max(width, height, 1);
  return Math.max(0, Math.ceil(Math.log2(Math.max(maxDim / TILE_SIZE, 1))));
};

async function uploadFileChunked(file, containerName, onProgress) {
  const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB chunks
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  console.log(`[Upload] Starting: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB), chunks: ${totalChunks}`);

  // Upload chunks one by one (more reliable than parallel for very large files)
  for (let index = 0; index < totalChunks; index++) {
    const start = index * CHUNK_SIZE;
    const end = Math.min(file.size, start + CHUNK_SIZE);
    const chunk = file.slice(start, end);

    const formData = new FormData();
    formData.append("file", chunk, file.name);
    formData.append("upload_id", uploadId);
    formData.append("chunk_index", String(index));

    let success = false;
    let lastError = null;

    // Retry each chunk up to 3 times
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${API}/upload-chunk`, {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text}`);
        }

        success = true;
        break;
      } catch (err) {
        lastError = err;
        console.warn(`[Upload] Chunk ${index} attempt ${attempt} failed:`, err.message);
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }

    if (!success) {
      throw new Error(`Failed to upload chunk ${index} after 3 retries: ${lastError?.message}`);
    }

    // Update progress
    const percent = Math.round(((index + 1) / totalChunks) * 100);
    if (onProgress) onProgress(percent);
  }

  console.log(`[Upload] All ${totalChunks} chunks uploaded. Calling upload-complete...`);

  // Final assembly step
  const completeForm = new FormData();
  completeForm.append("upload_id", uploadId);
  completeForm.append("filename", file.name);
  completeForm.append("total_chunks", String(totalChunks));
  completeForm.append("container_name", containerName);

  const completeRes = await fetch(`${API}/upload-complete`, {
    method: "POST",
    body: completeForm,
  });

  if (!completeRes.ok) {
    const text = await completeRes.text();
    console.error(`[Upload] upload-complete failed:`, completeRes.status, text);
    throw new Error(`Upload finalization failed: ${completeRes.status} ${text}`);
  }

  const result = await completeRes.json();
  console.log(`[Upload] Success:`, result);
  return result;
}

export default function ImageViewer() {
  const [containers, setContainers] = useState({});
  const [pendingFiles, setPendingFiles] = useState([]);
  const [showContainerModal, setShowContainerModal] = useState(false);
  const [fileDisplayNames, setFileDisplayNames] = useState({});
  const [selectedFile, setSelectedFile] = useState(null);
  const [rasterInfo, setRasterInfo] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);

  const [activeContainer, setActiveContainer] = useState(null);
  const [activeRgbContainer, setActiveRgbContainer] = useState("");

  const [rFile, setRFile] = useState("");
  const [gFile, setGFile] = useState("");
  const [bFile, setBFile] = useState("");

  const [showHistogram, setShowHistogram] = useState(false);
  const [histR, setHistR] = useState(null);
  const [histG, setHistG] = useState(null);
  const [histB, setHistB] = useState(null);
  const [histRLoading, setHistRLoading] = useState(false);
  const [histGLoading, setHistGLoading] = useState(false);
  const [histBLoading, setHistBLoading] = useState(false);
  const [histDefaultData, setHistDefaultData] = useState(null);
  const [histDefaultLoading, setHistDefaultLoading] = useState(false);

  const [histDropdownFile, setHistDropdownFile] = useState("");
  const [histActiveChannel, setHistActiveChannel] = useState(null);
  const [histSelectedRange, setHistSelectedRange] = useState(null);
  const [histSelectedChannel, setHistSelectedChannel] = useState(null);
  const [histBoxDrag, setHistBoxDrag] = useState(null);

  const [stretchValues, setStretchValues] = useState({
    default: { min: "", max: "" },
    r: { min: "", max: "" },
    g: { min: "", max: "" },
    b: { min: "", max: "" },
  });

  const [showScatterPlot, setShowScatterPlot] = useState(false);
  const [scatterXFile, setScatterXFile] = useState("");
  const [scatterXBand, setScatterXBand] = useState(1);
  const [scatterYFile, setScatterYFile] = useState("");
  const [scatterYBand, setScatterYBand] = useState(1);
  const [scatterData, setScatterData] = useState(null);
  const [isScatterLoading, setIsScatterLoading] = useState(false);

  const [isProfileMode, setIsProfileMode] = useState(false);
  const [profileStart, setProfileStart] = useState(null);
  const [profileEnd, setProfileEnd] = useState(null);
  const [isDrawingProfile, setIsDrawingProfile] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [profileData, setProfileData] = useState(null);
  const [isProfileLoading, setIsProfileLoading] = useState(false);
  const [profileFile, setProfileFile] = useState("");
  const [selectedProfileBand, setSelectedProfileBand] = useState(1);

  const [isSwipeMode, setIsSwipeMode] = useState(false);
  const [swipeLeftFile, setSwipeLeftFile] = useState("");
  const [swipeRightFile, setSwipeRightFile] = useState("");
  const [swipePosition, setSwipePosition] = useState(50);
  const [isDraggingSwipeDivider, setIsDraggingSwipeDivider] = useState(false);
  const [swipeLeftLoading, setSwipeLeftLoading] = useState(false);
  const [swipeRightLoading, setSwipeRightLoading] = useState(false);

  const [chunkImages, setChunkImages] = useState({});
  const [loadingChunks, setLoadingChunks] = useState([]);
  const [imageUrl, setImageUrl] = useState("");
  const [displayedImageUrl, setDisplayedImageUrl] = useState("");
  const [isImageLoading, setIsImageLoading] = useState(false);
  const [showOverviewInViewport, setShowOverviewInViewport] = useState(false);
  const [osdReady, setOsdReady] = useState(false);
  const [viewMode, setViewMode] = useState("");
  const [toast, setToast] = useState(null);

  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  const [miniRect, setMiniRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [showMinimap, setShowMinimap] = useState(true);

  const [mouseInfo, setMouseInfo] = useState(null);   // {x, y, value, lon, lat}
  const mouseInfoTimeoutRef = useRef(null);

  const containerRef = useRef(null);
  const imgRef = useRef(null);
  const overviewImgRef = useRef(null);
  const abortControllerRef = useRef(null);
  const activeObjectUrlRef = useRef(null);
  const thumbnailCacheRef = useRef({});
  const rgbBeforeHistRef = useRef(null);
  const viewStateRef = useRef({});
  const currentViewKeyRef = useRef(null);
  const viewBeforeSwipeRef = useRef(null);
  const stretchStateRef = useRef({});
  const imageHistoryRef = useRef({});
  const historyContextRef = useRef(null);
  const viewerRef = useRef(null);
  const osdContainerRef = useRef(null);
  const loadSequenceRef = useRef(0);
  const osdFirstTileRef = useRef(false);
  const lastViewedFileByContainerRef = useRef({});
  const viewerInteractionRef = useRef({ dragging: false, lastX: 0, lastY: 0, moved: false, suppressClick: false });
  const currentRasterSizeRef = useRef({ width: 1, height: 1 });
  const metadataCacheRef = useRef({});
  const overviewBlobCacheRef = useRef({});

  const containerRgbRef = useRef({});
  const containerStretchRef = useRef({});
  const containerViewStateRef = useRef({});

  const userHasSetViewRef = useRef(false);
const forceCleanViewerState = () => {
  // 1. Abort any ongoing request
  if (abortControllerRef.current) {
    try { abortControllerRef.current.abort(); } catch (_) {}
    abortControllerRef.current = null;
  }

  // 2. Destroy OpenSeadragon completely
  if (viewerInteractionRef.current.cleanup) {
    try { viewerInteractionRef.current.cleanup(); } catch (_) {}
    viewerInteractionRef.current.cleanup = null;
  }
  if (viewerRef.current) {
    try { viewerRef.current.destroy(); } catch (_) {}
    viewerRef.current = null;
  }

  // 3. Clean object URLs
  if (activeObjectUrlRef.current) {
    try { URL.revokeObjectURL(activeObjectUrlRef.current); } catch (_) {}
    activeObjectUrlRef.current = null;
  }

  // 4. Reset visual state
  setDisplayedImageUrl("");
  setShowOverviewInViewport(false);
  setIsImageLoading(true);
  setOsdReady(false);
  osdFirstTileRef.current = false;
  setMiniRect({ left: 0, top: 0, width: 1, height: 1 });
};
  const getHistoryKey = (containerName, filename) => {
    if (!containerName || !filename) return null;
    return `image:${containerName}:${filename}`;
  };

  // Per-container "last RGB composite view" history. Keyed the same way
  // as per-file history (getHistoryKey), just under a stable marker
  // instead of a real filename, so a container's composite (which R/G/B
  // bands are shown, its stretch, and its zoom/pan) can be saved and
  // restored as its own unit — independent of whichever individual file
  // was last clicked directly.
  const RGB_HISTORY_MARKER = "__rgb_composite__";
  const getRgbHistoryKey = (containerName) => getHistoryKey(containerName, RGB_HISTORY_MARKER);
  const setRgbHistoryContext = (containerName) => {
    const key = getRgbHistoryKey(containerName);
    historyContextRef.current = key ? { key, containerName, baseFile: RGB_HISTORY_MARKER } : null;
    return key;
  };
  const getSavedRgbHistory = (containerName) => {
    const key = getRgbHistoryKey(containerName);
    return key ? imageHistoryRef.current[key] || null : null;
  };

  const saveCurrentImageHistory = () => {
  const context = historyContextRef.current;
  if (!context?.key) return;

  const record = {
    containerName: context.containerName,
    baseFile: context.baseFile,
    selectedFile: selectedFile || null,
    viewMode,
    rFile,
    gFile,
    bFile,
    stretchValues: cloneStretchValues(stretchValues),
    histDropdownFile,
    histActiveChannel,
    histSelectedRange: histSelectedRange ? { ...histSelectedRange } : null,
    histSelectedChannel,
    showHistogram,
    scale,
    position: { ...position },
    displayedImageUrl,
  };

  // Capture the real OpenSeadragon viewport state
  if (viewerRef.current?.viewport) {
    try {
      const viewport = viewerRef.current.viewport;
      const center = viewport.getCenter();
      const homeZoom = viewport.getHomeZoom();
      record.osdZoom = viewport.getZoom();
      record.osdCenter = { x: center.x, y: center.y };
      record.osdHomeZoom = homeZoom;
      record.scale = homeZoom > 0 ? viewport.getZoom() / homeZoom : scale;
    } catch (error) {
      // Viewer may be between destroy/open
    }
  }

  imageHistoryRef.current[context.key] = record;

  if (context.containerName && context.baseFile) {
    lastViewedFileByContainerRef.current[context.containerName] = context.baseFile;
  }
};

  const getSavedImageHistory = (containerName, filename) => {
    const key = getHistoryKey(containerName, filename);
    return key ? imageHistoryRef.current[key] || null : null;
  };

  const setHistoryContext = (containerName, filename) => {
    const key = getHistoryKey(containerName, filename);
    historyContextRef.current = key ? { key, containerName, baseFile: filename } : null;
    return key;
  };

  const rasterViewKey = (filename) => `raster:${filename}`;
  const compositeViewKey = (r, g, b) => `rgb:${r}:${g}:${b}`;

  const createEmptyStretchValues = () => ({
    default: { min: "", max: "" },
    r: { min: "", max: "" },
    g: { min: "", max: "" },
    b: { min: "", max: "" },
  });

  const cloneStretchValues = useCallback((values) => {
    if (!values) return createEmptyStretchValues();
    return {
      default: { min: values.default?.min ?? "", max: values.default?.max ?? "" },
      r: { min: values.r?.min ?? "", max: values.r?.max ?? "" },
      g: { min: values.g?.min ?? "", max: values.g?.max ?? "" },
      b: { min: values.b?.min ?? "", max: values.b?.max ?? "" },
    };
  }, []);

  const saveFileStretch = (filename, channel, min, max) => {
    if (!filename) return;
    const previousStretch = stretchStateRef.current[filename] || createEmptyStretchValues();
    stretchStateRef.current[filename] = { ...previousStretch, [channel]: { min, max } };
  };

  const getFileStretch = (filename) => {
    if (!filename) return createEmptyStretchValues();
    return cloneStretchValues(stretchStateRef.current[filename]);
  };

  const MIN_SCALE = 0.05;
  const MAX_SCALE = 50;

  const showToast = (message, type = "error") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };

  const getDisplayFilename = (filePath) => {
    if (!filePath) return "";
    return filePath.replace(/\\/g, "/").split("/").pop();
  };

  const getDisplayName = useCallback(
    (storageKey) => {
      if (!storageKey) return "";
      return fileDisplayNames[storageKey] || getDisplayFilename(storageKey);
    },
    [fileDisplayNames]
  );
// Parse virtual band key: "Container1/file.tif::band3" → {filename, band}
const parseBandKey = (key) => {
  if (!key) return { filename: "", band: 1 };
  if (key.includes("::band")) {
    const [filename, bandPart] = key.split("::band");
    return { filename, band: parseInt(bandPart, 10) || 1 };
  }
  return { filename: key, band: 1 };
};

// Expand a multi-band file into virtual band entries
const expandMultiBandFile = async (containerName, filePath) => {
  try {
    const res = await axios.get(`${API}/metadata`, { params: { filename: filePath } });
    const bandCount = res.data.bands || 1;

    if (bandCount <= 1) return; // single-band – keep as is

    const bandEntries = [];
    const newDisplayNames = {};

    for (let b = 1; b <= bandCount; b++) {
      const bandKey = `${filePath}::band${b}`;
      bandEntries.push(bandKey);
      newDisplayNames[bandKey] = `${getDisplayFilename(filePath)} - Band ${b}`;
    }

    setFileDisplayNames((prev) => ({ ...prev, ...newDisplayNames }));

    setContainers((prev) => {
      const files = prev[containerName] || [];
      // Remove the original file and add the band entries
      const filtered = files.filter((f) => f !== filePath);
      return {
        ...prev,
        [containerName]: [...filtered, ...bandEntries],
      };
    });
  } catch (err) {
    console.error("Failed to expand multi-band file:", err);
  }
};
  const getContainerForFile = (filename) => {
    for (const [containerName, files] of Object.entries(containers)) {
      if (files.includes(filename)) return containerName;
    }
    return null;
  };

  const activeFilesPool = useMemo(() => {
    if (activeContainer && containers[activeContainer]) return containers[activeContainer];
    return [];
  }, [activeContainer, containers]);

  const allFilesList = useMemo(() => Object.values(containers).flat(), [containers]);

  const getThumbnailUrl = useCallback((filePath) => {
    if (!thumbnailCacheRef.current[filePath]) {
      thumbnailCacheRef.current[filePath] = `${API}/thumbnail?filename=${encodeURIComponent(filePath)}`;
    }
    return thumbnailCacheRef.current[filePath];
  }, []);

  // ========== IMPROVED METADATA WAIT ==========
  // ========== 1. Stronger metadata wait ==========
const waitForRasterMetadata = async (filename, attempts = 10, delayMs = 300) => {
  if (metadataCacheRef.current[filename]) {
    return metadataCacheRef.current[filename];
  }

  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await axios.get(`${API}/metadata`, {
        params: { filename },
        timeout: 3000,
      });
      if (res?.data?.width && res?.data?.height) {
        metadataCacheRef.current[filename] = res.data;
        return res.data;
      }
      lastError = new Error("No dimensions");
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError || new Error("Metadata unavailable");
};

 const buildOverviewUrl = (url) => {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith("/rgb-composite")) {
      const params = new URLSearchParams({
        r_file: parsed.searchParams.get("r_file") || "",
        g_file: parsed.searchParams.get("g_file") || "",
        b_file: parsed.searchParams.get("b_file") || "",
        max_size: "600",
      });
      ["r_min", "r_max", "g_min", "g_max", "b_min", "b_max"].forEach((key) => {
        const value = parsed.searchParams.get(key);
        if (value !== null && value !== "") params.set(key, value);
      });
      return `${API}/rgb-overview?${params.toString()}`;
    }

   const filename = parsed.searchParams.get("filename");
  const band = parsed.searchParams.get("band") || "1";
  const minVal = parsed.searchParams.get("min_val");
  const maxVal = parsed.searchParams.get("max_val");
  const params = new URLSearchParams({
    filename: filename || "",
    band: band,
    max_size: "600",
  });
  if (minVal) params.set("min_val", minVal);
  if (maxVal) params.set("max_val", maxVal);
  return `${API}/overview?${params.toString()}`;
};

const buildFastPreviewUrl = (url) => {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith("/rgb-composite")) {
    const params = new URLSearchParams({
      r_file: parsed.searchParams.get("r_file") || "",
      g_file: parsed.searchParams.get("g_file") || "",
      b_file: parsed.searchParams.get("b_file") || "",
      max_size: "280",
    });
    ["r_min","r_max","g_min","g_max","b_min","b_max"].forEach((key) => {
      const value = parsed.searchParams.get(key);
      if (value !== null && value !== "") params.set(key, value);
    });
    return `${API}/rgb-overview?${params.toString()}`;
  }
 const filename = parsed.searchParams.get("filename");
  const band = parsed.searchParams.get("band") || "1";
  if (!filename || !parsed.pathname.endsWith("/image")) return null;
  return `${API}/fast-overview?filename=${encodeURIComponent(filename)}&band=${band}&max_size=240`;
};

  // ========== IMPROVED OVERVIEW LOADER (never hangs > 10s) ==========
  // ========== 2. Much more reliable overview loader ==========
const loadVerifiedOverview = async (url, requestId) => {
  const overviewUrl = buildOverviewUrl(url);
  const fastPreviewUrl = buildFastPreviewUrl(url);
  const deadline = Date.now() + 9000; // hard limit < 10 s
  let lastError = null;
  let hasPublishedOverview = false;

  const publishObjectUrl = (objectUrl) => {
    if (requestId !== loadSequenceRef.current) {
      URL.revokeObjectURL(objectUrl);
      return false;
    }
    if (activeObjectUrlRef.current) {
      URL.revokeObjectURL(activeObjectUrlRef.current);
    }
    activeObjectUrlRef.current = objectUrl;
    setDisplayedImageUrl(objectUrl);
    setShowOverviewInViewport(!osdFirstTileRef.current);
    setIsImageLoading(false);
    hasPublishedOverview = true;
    return true;
  };

  const tryFetchImage = async (imageUrl, timeoutMs) => {
    // Always check cache first
    const cachedBlob = overviewBlobCacheRef.current[imageUrl];
    if (cachedBlob) {
      return URL.createObjectURL(cachedBlob);
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(imageUrl, {
        signal: controller.signal,
        cache: "force-cache", // help browser cache
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (!blob || blob.size === 0) throw new Error("Empty response");
      overviewBlobCacheRef.current[imageUrl] = blob;
      return URL.createObjectURL(blob);
    } finally {
      window.clearTimeout(timeout);
    }
  };

  // ---- Priority 1: Fast overview (critical for large files) ----
if (fastPreviewUrl && requestId === loadSequenceRef.current) {
  for (let i = 0; i < 5; i++) {
    if (requestId !== loadSequenceRef.current) return false;
    try {
      const timeout = i === 0 ? 4500 : 3000;
      const objectUrl = await tryFetchImage(fastPreviewUrl, timeout);
      if (publishObjectUrl(objectUrl)) break;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 350));
    }
  }
}
  // ---- Priority 2: Better overview (only if we still have time) ----
  while (Date.now() < deadline && requestId === loadSequenceRef.current) {
    if (hasPublishedOverview) {
      // We already have something on screen – good enough
      setIsImageLoading(false);
      return true;
    }

    const remaining = Math.max(400, deadline - Date.now());
    try {
      const objectUrl = await tryFetchImage(overviewUrl, Math.min(2000, remaining));
      if (publishObjectUrl(objectUrl)) return true;
    } catch (err) {
      lastError = err;
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  // Final safety net
  if (requestId === loadSequenceRef.current) {
    setIsImageLoading(false);
    if (!hasPublishedOverview) {
      console.warn("Overview timed out:", lastError);
      showToast("Image took too long. Click the file again.", "error");
    }
  }
  return hasPublishedOverview;
};

  const updateMiniRectFromViewer = (width, height, viewer = viewerRef.current) => {
    if (!viewer?.viewport || !width || !height) return;
    try {
      const viewportBounds = viewer.viewport.getBounds(true);
      const imageBounds = viewer.viewport.viewportToImageRectangle(viewportBounds);

      const left = Math.max(0, Math.min(1, imageBounds.x / width));
      const top = Math.max(0, Math.min(1, imageBounds.y / height));
      const right = Math.max(left, Math.min(1, (imageBounds.x + imageBounds.width) / width));
      const bottom = Math.max(top, Math.min(1, (imageBounds.y + imageBounds.height) / height));

      setMiniRect({
        left,
        top,
        width: Math.max(0, Math.min(1, right - left)),
        height: Math.max(0, Math.min(1, bottom - top)),
      });
    } catch (error) {}
  };

  const buildAndShowTiles = async (tileParams, requestId, restoreViewport = null) => {
    if (viewerInteractionRef.current.cleanup) {
      viewerInteractionRef.current.cleanup();
      viewerInteractionRef.current.cleanup = null;
    }
    if (viewerRef.current) {
      viewerRef.current.destroy();
      viewerRef.current = null;
    }
    if (!osdContainerRef.current || requestId !== loadSequenceRef.current) return;

    const metaFile = tileParams.type === "rgb" ? tileParams.r : tileParams.file;
    if (!metaFile) return;

    setIsImageLoading(true);
    setOsdReady(false);
    osdFirstTileRef.current = false;

    try {
      const metadata = await waitForRasterMetadata(metaFile);
      const { width, height } = metadata;
      currentRasterSizeRef.current = { width, height };
      if (!osdContainerRef.current || requestId !== loadSequenceRef.current) return;

      const maxLevel = computeMaxLevel(width, height);

      const buildRasterTileUrl = (level, x, y) => {
  const { filename, band } = parseBandKey(tileParams.file);
  let tileUrl = `${API}/tile?filename=${encodeURIComponent(filename)}&band=${band}&z=${level}&x=${x}&y=${y}`;
  if (tileParams.min !== "" && tileParams.min != null) tileUrl += `&min_val=${encodeURIComponent(tileParams.min)}`;
  if (tileParams.max !== "" && tileParams.max != null) tileUrl += `&max_val=${encodeURIComponent(tileParams.max)}`;
  return tileUrl;
};

      const buildRgbTileUrl = (level, x, y) => {
        let tileUrl = `${API}/rgb-tile?r_file=${encodeURIComponent(tileParams.r)}&g_file=${encodeURIComponent(tileParams.g)}&b_file=${encodeURIComponent(tileParams.b)}&z=${level}&x=${x}&y=${y}`;
        [["r_min", tileParams.rMin], ["r_max", tileParams.rMax], ["g_min", tileParams.gMin], ["g_max", tileParams.gMax], ["b_min", tileParams.bMin], ["b_max", tileParams.bMax]].forEach(([key, val]) => {
          if (val !== "" && val != null) tileUrl += `&${key}=${encodeURIComponent(val)}`;
        });
        return tileUrl;
      };

      const tileSource = {
        width,
        height,
        tileSize: TILE_SIZE,
        tileOverlap: 0,
        minLevel: 0,
        maxLevel,
        getTileUrl: tileParams.type === "rgb" ? buildRgbTileUrl : buildRasterTileUrl,
      };

      viewerRef.current = OpenSeadragon({
        id: osdContainerRef.current.id,
        prefixUrl: "",
        crossOriginPolicy: "Anonymous",
        useCanvas: true,
        tileSources: tileSource,
        showNavigationControl: false,
        gestureSettingsMouse: {
          clickToZoom: false,
          dblClickToZoom: false,
          dragToPan: false,
          scrollToZoom: false,
        },
        homeFillsViewer: false,
        visibilityRatio: 1,
        constrainDuringPan: true,
        minZoomImageRatio: 1,
        maxZoomPixelRatio: 4,
        zoomPerScroll: 1.2,
        animationTime: 0.8,
        mouseNavEnabled: false,
        immediateRender: true,
        imageLoaderLimit: 6,
        maxImageCacheCount: 256,
        smoothTileEdgesMinZoom: 1.0,
      });

      const surface = osdContainerRef.current;
      const viewer = viewerRef.current;
      if (surface && viewer) {
        surface.style.cursor = "grab";
        surface.style.touchAction = "none";
        surface.style.userSelect = "none";

        const interaction = viewerInteractionRef.current;
        const onWheel = (event) => {
          if (requestId !== loadSequenceRef.current || !viewer.viewport) return;
          event.preventDefault();
          event.stopPropagation();

          const rect = surface.getBoundingClientRect();
          const pixel = new OpenSeadragon.Point(
            event.clientX - rect.left,
            event.clientY - rect.top
          );
          const refPoint = viewer.viewport.pointFromPixel(pixel, true);
          const factor = event.deltaY < 0 ? 1.25 : 0.8;

          viewer.viewport.zoomBy(factor, refPoint, true);
          viewer.viewport.applyConstraints();
          userHasSetViewRef.current = true;
          updateMiniRectFromViewer(width, height, viewer);
          saveCurrentImageHistory();
        };

        const onPointerDown = (event) => {
          if (requestId !== loadSequenceRef.current || event.button !== 0 || !viewer.viewport) return;

          interaction.dragging = true;
          interaction.moved = false;
          interaction.lastX = event.clientX;
          interaction.lastY = event.clientY;
          surface.style.cursor = "grabbing";

          try {
            surface.setPointerCapture(event.pointerId);
          } catch (_) {}

          event.preventDefault();
          event.stopPropagation();
        };

        const onPointerMove = (event) => {
          if (!interaction.dragging || requestId !== loadSequenceRef.current || !viewer.viewport) return;

          const dx = event.clientX - interaction.lastX;
          const dy = event.clientY - interaction.lastY;
          if (Math.abs(dx) + Math.abs(dy) > 1) interaction.moved = true;

          interaction.lastX = event.clientX;
          interaction.lastY = event.clientY;

          const delta = viewer.viewport.deltaPointsFromPixels(
            new OpenSeadragon.Point(dx, dy),
            true
          );
          viewer.viewport.panBy(delta.times(-1), true);
          viewer.viewport.applyConstraints();
          userHasSetViewRef.current = true;
          updateMiniRectFromViewer(width, height, viewer);

          event.preventDefault();
          event.stopPropagation();
        };

        const finishPointer = (event) => {
          if (!interaction.dragging) return;
          interaction.dragging = false;
          surface.style.cursor = "grab";
          try {
            surface.releasePointerCapture(event.pointerId);
          } catch (_) {}
          saveCurrentImageHistory();
          event.preventDefault();
          event.stopPropagation();
        };

        const onDoubleClick = (event) => {
          if (requestId !== loadSequenceRef.current || !viewer.viewport) return;

          const rect = surface.getBoundingClientRect();
          const pixel = new OpenSeadragon.Point(
            event.clientX - rect.left,
            event.clientY - rect.top
          );
          const refPoint = viewer.viewport.pointFromPixel(pixel, true);

          viewer.viewport.zoomBy(2, refPoint, true);
          viewer.viewport.applyConstraints();
          userHasSetViewRef.current = true;
          updateMiniRectFromViewer(width, height, viewer);
          saveCurrentImageHistory();
          event.preventDefault();
          event.stopPropagation();
        };

        surface.addEventListener("wheel", onWheel, { passive: false });
        surface.addEventListener("pointerdown", onPointerDown);
        surface.addEventListener("pointermove", onPointerMove);
        surface.addEventListener("pointerup", finishPointer);
        surface.addEventListener("pointercancel", finishPointer);
        surface.addEventListener("dblclick", onDoubleClick);

        viewerInteractionRef.current.cleanup = () => {
          surface.removeEventListener("wheel", onWheel);
          surface.removeEventListener("pointerdown", onPointerDown);
          surface.removeEventListener("pointermove", onPointerMove);
          surface.removeEventListener("pointerup", finishPointer);
          surface.removeEventListener("pointercancel", finishPointer);
          surface.removeEventListener("dblclick", onDoubleClick);
          surface.style.cursor = "default";
          surface.style.touchAction = "";
          surface.style.userSelect = "";
        };
      }

      viewerRef.current.addOnceHandler("open", () => {
        if (requestId !== loadSequenceRef.current) return;
        setOsdReady(true);
        const viewer = viewerRef.current;
        if (viewer) {
          viewer.viewport.goHome(true);
          viewer.viewport.applyConstraints();

          const restore = restoreViewport && Number.isFinite(restoreViewport.osdZoom) && restoreViewport.osdCenter
            ? restoreViewport
            : null;

          requestAnimationFrame(() => {
            if (!viewerRef.current || requestId !== loadSequenceRef.current) return;
            const currentViewer = viewerRef.current;
            currentViewer.viewport.goHome(true);
            currentViewer.viewport.applyConstraints();
            if (restore) {
              currentViewer.viewport.zoomTo(restore.osdZoom, null, true);
              currentViewer.viewport.panTo(
                new OpenSeadragon.Point(restore.osdCenter.x, restore.osdCenter.y),
                true
              );
              currentViewer.viewport.applyConstraints();
            }
            updateMiniRectFromViewer(width, height, currentViewer);
          });
        }
      });

      viewerRef.current.addHandler("viewport-change", () => {
        if (requestId !== loadSequenceRef.current || !viewerRef.current) return;
        const viewer = viewerRef.current;
        const homeZoom = viewer.viewport.getHomeZoom();
        const zoom = viewer.viewport.getZoom();
        setScale(homeZoom > 0 ? zoom / homeZoom : 1);
        updateMiniRectFromViewer(width, height, viewer);
        saveCurrentImageHistory();
      });

      viewerRef.current.addHandler("animation-finish", () => {
        if (requestId !== loadSequenceRef.current || !viewerRef.current) return;
        updateMiniRectFromViewer(width, height, viewerRef.current);
        saveCurrentImageHistory();
      });

      viewerRef.current.addOnceHandler("tile-drawn", () => {
        if (requestId !== loadSequenceRef.current) return;
        osdFirstTileRef.current = true;
        setShowOverviewInViewport(false);
      });

      viewerRef.current.addHandler("resize", () => {
        const viewer = viewerRef.current;
        if (!viewer || requestId !== loadSequenceRef.current) return;
        if (viewer.viewport.getZoom() <= viewer.viewport.getHomeZoom() * 1.01) {
          viewer.viewport.goHome(true);
        }
      });

      viewerRef.current.addOnceHandler("open-failed", () => {
        if (requestId !== loadSequenceRef.current) return;
        setOsdReady(false);
      });
    } catch (error) {
      console.error("Failed to initialize tiled viewer:", error);
      if (requestId === loadSequenceRef.current) setOsdReady(false);
    }
  };

  // ========== IMPROVED loadImage ==========
const loadImage = (url, viewKey = null, preserveView = false, restoreViewport = null) => {
  // Clean everything first
  forceCleanViewerState();

  const requestId = ++loadSequenceRef.current;
  abortControllerRef.current = new AbortController();

  setImageUrl(url);
  userHasSetViewRef.current = Boolean(restoreViewport);
  currentViewKeyRef.current = viewKey;

  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    setIsImageLoading(false);
    showToast("Invalid image URL", "error");
    return;
  }

  // Start tiles
  if (parsed.pathname.endsWith("/rgb-composite")) {
    buildAndShowTiles({
      type: "rgb",
      r: parsed.searchParams.get("r_file"),
      g: parsed.searchParams.get("g_file"),
      b: parsed.searchParams.get("b_file"),
      rMin: parsed.searchParams.get("r_min"),
      rMax: parsed.searchParams.get("r_max"),
      gMin: parsed.searchParams.get("g_min"),
      gMax: parsed.searchParams.get("g_max"),
      bMin: parsed.searchParams.get("b_min"),
      bMax: parsed.searchParams.get("b_max"),
    }, requestId, restoreViewport);
  } else if (parsed.pathname.endsWith("/image")) {
    buildAndShowTiles({
      type: "raster",
      file: parsed.searchParams.get("filename"),
      min: parsed.searchParams.get("min_val"),
      max: parsed.searchParams.get("max_val"),
    }, requestId, restoreViewport);
  }

  // Start overview
  loadVerifiedOverview(url, requestId).then((loaded) => {
    if (requestId === loadSequenceRef.current && !loaded) {
      setIsImageLoading(false);
    }
  });
};

  useEffect(() => {
    if (isSwipeMode && viewerRef.current) {
      viewerRef.current.destroy();
      viewerRef.current = null;
    }
  }, [isSwipeMode]);

  useEffect(() => {
    if (!activeContainer) return;
    containerViewStateRef.current[activeContainer] = {
      scale,
      position: { ...position },
      rFile,
      gFile,
      bFile,
      stretch: cloneStretchValues(stretchValues),
    };
  }, [scale, position, rFile, gFile, bFile, stretchValues, activeContainer]);

  useEffect(() => {
    saveCurrentImageHistory();
  }, [
    selectedFile, viewMode, rFile, gFile, bFile, stretchValues,
    histDropdownFile, histActiveChannel, histSelectedRange,
    histSelectedChannel, showHistogram, scale, position, displayedImageUrl,
  ]);

  useEffect(() => {
    const updateMini = () => {
      if (viewerRef.current && rasterInfo?.width && rasterInfo?.height) {
        updateMiniRectFromViewer(rasterInfo.width, rasterInfo.height, viewerRef.current);
      } else if (displayedImageUrl) {
        setMiniRect({ left: 0, top: 0, width: 1, height: 1 });
      }
    };
    updateMini();
    window.addEventListener("resize", updateMini);
    return () => window.removeEventListener("resize", updateMini);
  }, [displayedImageUrl, rasterInfo?.width, rasterInfo?.height, isSwipeMode]);

  const buildSingleImageUrl = (fileKey, stretch) => {
  const { filename, band } = parseBandKey(fileKey);
  let url = `${API}/image?filename=${encodeURIComponent(filename)}&band=${band}`;
  if (stretch && stretch.min !== "" && stretch.min != null) url += `&min_val=${encodeURIComponent(stretch.min)}`;
  if (stretch && stretch.max !== "" && stretch.max != null) url += `&max_val=${encodeURIComponent(stretch.max)}`;
  return url;
};

// ========== PIXEL VALUE + COORDINATES ==========
useEffect(() => {
  if (isSwipeMode || !osdReady) {
    setMouseInfo(null);
    return;
  }

  const surface = osdContainerRef.current;
  if (!surface || !viewerRef.current) return;

  const handleMouseMove = (e) => {
    const viewer = viewerRef.current;
    if (!viewer?.viewport) return;

    const rect = surface.getBoundingClientRect();
    const pixel = new OpenSeadragon.Point(
      e.clientX - rect.left,
      e.clientY - rect.top
    );

    // Convert to image coordinates
    const imagePoint = viewer.viewport.viewerElementToImageCoordinates(pixel);
    const imgX = Math.round(imagePoint.x);
    const imgY = Math.round(imagePoint.y);

    // Debounce the API call
    if (mouseInfoTimeoutRef.current) {
      clearTimeout(mouseInfoTimeoutRef.current);
    }

    mouseInfoTimeoutRef.current = setTimeout(async () => {
      // Decide which file + band to query
      let fileKey = selectedFile || rFile || activeFilesPool[0];
      if (!fileKey) return;

      const { filename, band } = parseBandKey(fileKey);

      try {
        const res = await axios.get(`${API}/pixel-value`, {
          params: { filename, x: imgX, y: imgY, band },
          timeout: 2000,
        });
        setMouseInfo(res.data);
      } catch (err) {
        // silent fail
      }
    }, 80); // small debounce
  };

  const handleMouseLeave = () => {
    setMouseInfo(null);
    if (mouseInfoTimeoutRef.current) {
      clearTimeout(mouseInfoTimeoutRef.current);
    }
  };

  surface.addEventListener("mousemove", handleMouseMove);
  surface.addEventListener("mouseleave", handleMouseLeave);

  return () => {
    surface.removeEventListener("mousemove", handleMouseMove);
    surface.removeEventListener("mouseleave", handleMouseLeave);
    if (mouseInfoTimeoutRef.current) {
      clearTimeout(mouseInfoTimeoutRef.current);
    }
  };
}, [isSwipeMode, osdReady, selectedFile, rFile, activeFilesPool]);

  const buildCompositeUrl = (r, g, b, stretch) => {
    let url = `${API}/rgb-composite?r_file=${encodeURIComponent(r)}&g_file=${encodeURIComponent(g)}&b_file=${encodeURIComponent(b)}`;
    ["r", "g", "b"].forEach((ch) => {
      const s = stretch && stretch[ch];
      if (s && s.min !== "" && s.min != null) url += `&${ch}_min=${encodeURIComponent(s.min)}`;
      if (s && s.max !== "" && s.max != null) url += `&${ch}_max=${encodeURIComponent(s.max)}`;
    });
    return url;
  };

  const getHistogramPercentileValue = (data, percentile) => {
    if (!data || !data.counts || data.counts.length === 0) return null;
    const total = data.counts.reduce((a, b) => a + b, 0);
    if (total === 0) return null;
    const target = total * (percentile / 100);
    const binWidth = (data.max - data.min) / data.counts.length;
    let cumulative = 0;
    for (let i = 0; i < data.counts.length; i++) {
      cumulative += data.counts[i];
      if (cumulative >= target) return Number((data.min + i * binWidth).toFixed(3));
    }
    return data.max;
  };

  const updateStretchInput = (channel, field, value) => {
    setStretchValues((prev) => ({ ...prev, [channel]: { ...prev[channel], [field]: value } }));
  };

  const applyStretchWithValues = (channel, minVal, maxVal) => {
  const nextStretch = { ...stretchValues, [channel]: { min: minVal, max: maxVal } };
  setStretchValues(nextStretch);

  if (activeContainer) {
    containerStretchRef.current[activeContainer] = cloneStretchValues(nextStretch);
  }

  // Save current viewport before reloading
  let currentViewport = null;
  if (viewerRef.current?.viewport) {
    try {
      const vp = viewerRef.current.viewport;
      const center = vp.getCenter();
      currentViewport = {
        osdZoom: vp.getZoom(),
        osdCenter: { x: center.x, y: center.y },
      };
    } catch (_) {}
  }

  if (channel === "default") {
    const file = histDropdownFile || selectedFile;
    if (!file) return;
    saveFileStretch(file, "default", minVal, maxVal);
    setSelectedFile(file);
    setViewMode("raster");
    loadImage(
      buildSingleImageUrl(file, nextStretch.default),
      rasterViewKey(file),
      true,                // preserveView
      currentViewport      // keep same zoom/pan
    );
    setHistSelectedRange({ filename: file, channel: "default", min: minVal, max: maxVal });
    return;
  }

  const isRgbComposite = rFile && gFile && bFile;
  if (isRgbComposite) {
    const channelFile = channel === "r" ? rFile : channel === "g" ? gFile : bFile;
    saveFileStretch(channelFile, channel, minVal, maxVal);
    setSelectedFile(null);
    setViewMode("rgb");
    loadImage(
      buildCompositeUrl(rFile, gFile, bFile, nextStretch),
      compositeViewKey(rFile, gFile, bFile),
      true,
      currentViewport
    );
    if (channelFile) {
      setHistSelectedRange({ filename: channelFile, channel, min: minVal, max: maxVal });
    }
    return;
  }

  const targetFile = channel === "r" ? rFile : channel === "g" ? gFile : bFile;
  const fileToUse = targetFile || selectedFile;
  if (!fileToUse) return;
  saveFileStretch(fileToUse, channel, minVal, maxVal);
  setSelectedFile(fileToUse);
  setViewMode("raster");
  loadImage(
    buildSingleImageUrl(fileToUse, nextStretch[channel]),
    rasterViewKey(fileToUse),
    true,
    currentViewport
  );
  setHistSelectedRange({ filename: fileToUse, channel, min: minVal, max: maxVal });
};
  const applyStretch = (channel) => {
    const s = stretchValues[channel];
    if (!s) return;
    applyStretchWithValues(channel, s.min, s.max);
  };

  const applyAutoStretch = (channel, lowPct, highPct) => {
    const data =
      channel === "default" ? histDefaultData :
      channel === "r" ? histR :
      channel === "g" ? histG : histB;
    if (!data) {
      showToast(`No histogram data loaded yet.`, "error");
      return;
    }
    const lowVal = lowPct <= 0 ? data.min : getHistogramPercentileValue(data, lowPct);
    const highVal = highPct >= 100 ? data.max : getHistogramPercentileValue(data, highPct);
    applyStretchWithValues(channel, lowVal, highVal);
  };

  const resetStretch = (channel) => {
    const noStretch = createEmptyStretchValues();
    setStretchValues(noStretch);

    if (activeContainer) {
      containerStretchRef.current[activeContainer] = noStretch;
    }

    setShowHistogram(false);
    setHistActiveChannel(null);
    setHistSelectedRange(null);
    setHistSelectedChannel(null);
    rgbBeforeHistRef.current = null;

    // Preserve the current zoom/pan across the reload — clearing the
    // stretch should only change brightness/contrast, not reset where
    // you're looking. Every other stretch/band-change handler already
    // captures this; this one was the one place that didn't.
    let currentViewport = null;
    if (viewerRef.current?.viewport) {
      try {
        const vp = viewerRef.current.viewport;
        const center = vp.getCenter();
        currentViewport = {
          osdZoom: vp.getZoom(),
          osdCenter: { x: center.x, y: center.y },
        };
      } catch (_) {}
    }

    if (rFile && gFile && bFile) {
      setViewMode("rgb");
      setSelectedFile(null);
      loadImage(
        buildCompositeUrl(rFile, gFile, bFile, noStretch),
        compositeViewKey(rFile, gFile, bFile),
        true,
        currentViewport
      );
      return;
    }
    const fileToRestore = histDropdownFile || selectedFile || rFile || gFile || bFile;
    if (fileToRestore) {
      setSelectedFile(fileToRestore);
      setViewMode("raster");
      loadImage(
        buildSingleImageUrl(fileToRestore, noStretch.default),
        rasterViewKey(fileToRestore),
        true,
        currentViewport
      );
    }
  };

  const applyRGBFromFiles = useCallback(
    (containerName, files) => {
      if (files.length === 0) {
        setRFile("");
        setGFile("");
        setBFile("");
        return;
      }

      const r = files[0];
      const g = files[1] || files[0];
      const b = files[2] || g;

      setRFile(r);
      setGFile(g);
      setBFile(b);

      if (r && g && b) {
        containerRgbRef.current[containerName] = { r, g, b };
      }

      if (files.length >= 1) {
        setActiveRgbContainer(containerName);
        setViewMode("rgb");
        setSelectedFile(null);
        const currentStretch = stretchValues;
        loadImage(buildCompositeUrl(r, g, b, currentStretch), compositeViewKey(r, g, b), false);
      }
    },
    [stretchValues]
  );

  const autoSelectRGBForContainer = (containerName) => {
    const files = containers[containerName] || [];
    applyRGBFromFiles(containerName, files);
  };

  const restoreContainerView = (containerName) => {
    if (!containerName) return;
    const saved = containerViewStateRef.current[containerName];
    if (saved) {
      setScale(saved.scale);
      setPosition(saved.position);
    }
  };

 const recomputeRGBAfterDelete = (containerName, deletedFilename) => {
  const remainingFiles = (containers[containerName] || []).filter(
    (f) => f !== deletedFilename
  );

  if (remainingFiles.length === 0) {
    setRFile("");
    setGFile("");
    setBFile("");
    setSelectedFile(null);
    setViewMode("");
    setDisplayedImageUrl("");
    setRasterInfo(null);
    delete containerRgbRef.current[containerName];
    delete containerStretchRef.current[containerName];
    if (viewerRef.current) {
      try { viewerRef.current.destroy(); } catch (_) {}
      viewerRef.current = null;
    }
    return;
  }

  // Keep whichever of the current R/G/B slots are still valid; only the
  // slot(s) that pointed at the deleted file get replaced with another
  // available band from the container. This avoids resetting bands the
  // user already had selected just because one other band was deleted.
  const currentAssignment = containerRgbRef.current[containerName] || { r: rFile, g: gFile, b: bFile };
  const pickReplacement = (exclude) =>
    remainingFiles.find((f) => !exclude.includes(f)) || remainingFiles[0];

  let r = currentAssignment.r && currentAssignment.r !== deletedFilename && remainingFiles.includes(currentAssignment.r)
    ? currentAssignment.r : null;
  let g = currentAssignment.g && currentAssignment.g !== deletedFilename && remainingFiles.includes(currentAssignment.g)
    ? currentAssignment.g : null;
  let b = currentAssignment.b && currentAssignment.b !== deletedFilename && remainingFiles.includes(currentAssignment.b)
    ? currentAssignment.b : null;

  if (!r) r = pickReplacement([g, b].filter(Boolean));
  if (!g) g = pickReplacement([r, b].filter(Boolean));
  if (!b) b = pickReplacement([r, g].filter(Boolean));

  setRFile(r);
  setGFile(g);
  setBFile(b);
  setSelectedFile(null);
  setViewMode("rgb");
  setRgbHistoryContext(containerName);

  containerRgbRef.current[containerName] = { r, g, b };

  // Keep the existing stretch instead of wiping it — a deletion swapping
  // one band shouldn't discard contrast stretching the user already set
  // up on the composite (stretch is only cleared via the Reset button).
  loadImage(
    buildCompositeUrl(r, g, b, stretchValues),
    compositeViewKey(r, g, b),
    true
  );

  axios
    .get(`${API}/metadata`, { params: { filename: r } })
    .then((res) => setRasterInfo(res.data))
    .catch((err) => console.error("Failed to load raster info:", err));
};

  const handleFileSelectInput = (e) => {
    const uploadedFiles = e.target.files;
    if (!uploadedFiles || uploadedFiles.length === 0) return;
    const inputEl = e.target;
    const fileArray = Array.from(uploadedFiles);

    setPendingFiles(fileArray);
    inputEl.value = "";

    setContainers((currentContainers) => {
      const existingNames = Object.keys(currentContainers);
      if (existingNames.length === 0) {
        processUploadsToContainer("Container 1", fileArray);
      } else {
        setShowContainerModal(true);
      }
      return currentContainers;
    });
  };

  const getNextContainerName = () => {
    const names = Object.keys(containers);
    let maxNum = 0;
    names.forEach((name) => {
      const match = name.match(/^Container\s+(\d+)$/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (!Number.isNaN(n) && n > maxNum) maxNum = n;
      }
    });
    return `Container ${maxNum + 1}`;
  };

  const processUploadsToContainer = async (targetContainerName, filesToUpload) => {
  setShowContainerModal(false);

  for (const file of filesToUpload) {
    const storedFilePath = `${targetContainerName}/${file.name}`;

    // Prevent duplicates
    if ((containers[targetContainerName] || []).includes(storedFilePath)) {
      showToast(`${file.name} already exists in ${targetContainerName}`, "error");
      continue;
    }

    // Add to UI immediately
    setContainers((prev) => {
      const existing = prev[targetContainerName] || [];
      if (existing.includes(storedFilePath)) return prev;
      return {
        ...prev,
        [targetContainerName]: [...existing, storedFilePath],
      };
    });

    setFileDisplayNames((prev) => ({
      ...prev,
      [storedFilePath]: file.name,
    }));

    try {
      setIsUploading(true);
      setUploadProgress(0);

      await uploadFileChunked(file, targetContainerName, (percent) => {
        setUploadProgress(percent);
      });

      setActiveContainer(targetContainerName);
      setActiveRgbContainer(targetContainerName);

      // Expand multi-band if needed
      if (typeof expandMultiBandFile === "function") {
        await expandMultiBandFile(targetContainerName, storedFilePath);
      }

      showToast(`${file.name} uploaded successfully`, "success");

    } catch (error) {
      console.error("Upload failed:", error);
      showToast(`Upload failed for ${file.name}: ${error.message}`, "error");

      // Remove from sidebar if upload failed
      setContainers((prev) => {
        const updated = (prev[targetContainerName] || []).filter((f) => f !== storedFilePath);
        return { ...prev, [targetContainerName]: updated };
      });
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  }

  setPendingFiles([]);
};

  const handleDeleteContainer = (containerName) => {
    if (!window.confirm(`Delete entire container "${containerName}" and all its rasters?`)) return;

    const files = containers[containerName] || [];

    Promise.all(
      files.map((f) => axios.delete(`${API}/files/${encodeURIComponent(f)}`).catch(() => {}))
    ).then(() => {
      setContainers((prev) => {
        const updated = { ...prev };
        delete updated[containerName];
        return updated;
      });

      setFileDisplayNames((prev) => {
        const updated = { ...prev };
        files.forEach((f) => delete updated[f]);
        return updated;
      });

      files.forEach((f) => {
        delete viewStateRef.current[rasterViewKey(f)];
        delete stretchStateRef.current[f];
        for (const key of Object.keys(imageHistoryRef.current)) {
          if (key.endsWith(`:${f}`)) delete imageHistoryRef.current[key];
        }
      });

      delete containerRgbRef.current[containerName];
      delete containerStretchRef.current[containerName];
      delete containerViewStateRef.current[containerName];

      if (activeContainer === containerName) {
        setActiveContainer(null);
        setActiveRgbContainer("");
        setSelectedFile(null);
        setViewMode("");
        setDisplayedImageUrl("");
        setRasterInfo(null);
      }

      showToast(`Container "${containerName}" deleted`, "success");
    });
  };

  const resetView = () => {
  const viewer = viewerRef.current;
  userHasSetViewRef.current = false;

  if (viewer?.viewport) {
    viewer.viewport.goHome(true);          // back to 100%
    viewer.viewport.applyConstraints();
    saveCurrentImageHistory();
    return;
  }

  // Fallback if viewer is not ready
  setScale(1);
  setPosition({ x: 0, y: 0 });
};

  const handleSelectRaster = async (filename) => {
  if (isSwipeMode) return;

  // Save current view before leaving
  saveCurrentImageHistory();

  const containerName = getContainerForFile(filename) || activeContainer;
  if (containerName) lastViewedFileByContainerRef.current[containerName] = filename;

  const saved = getSavedImageHistory(containerName, filename);
  setHistoryContext(containerName, filename);

  if (saved) {
    // ---------- INSTANT RESTORE ----------
    setSelectedFile(filename);
    setViewMode(saved.viewMode || (saved.rFile && saved.gFile && saved.bFile ? "rgb" : "raster"));
    setRFile(saved.rFile || "");
    setGFile(saved.gFile || "");
    setBFile(saved.bFile || "");
    setStretchValues(cloneStretchValues(saved.stretchValues));
    setHistDropdownFile(saved.histDropdownFile || filename);
    setHistActiveChannel(saved.histActiveChannel || null);
    setHistSelectedRange(saved.histSelectedRange || null);
    setHistSelectedChannel(saved.histSelectedChannel || null);
    setShowHistogram(Boolean(saved.showHistogram));
    setActiveContainer(containerName || "");
    setActiveRgbContainer(containerName || "");

    // 1. Show the previous overview INSTANTLY if we still have it in memory
    if (saved.displayedImageUrl) {
      setDisplayedImageUrl(saved.displayedImageUrl);
      setShowOverviewInViewport(true);
      setIsImageLoading(false);
    }

    const isSavedRgb = saved.rFile && saved.gFile && saved.bFile;

    if (isSavedRgb) {
      setSelectedFile(null);
      setViewMode("rgb");
      loadImage(
        buildCompositeUrl(saved.rFile, saved.gFile, saved.bFile, saved.stretchValues),
        compositeViewKey(saved.rFile, saved.gFile, saved.bFile),
        true,               // preserveView
        saved               // restore exact zoom + pan
      );
    } else {
      setSelectedFile(filename);
      setViewMode("raster");
      loadImage(
        buildSingleImageUrl(filename, saved.stretchValues?.default || { min: "", max: "" }),
        rasterViewKey(filename),
        true,               // preserveView
        saved
      );
    }

    if (saved.showHistogram) {
      setHistDefaultData(null);
      fetchHistogramFor(filename, setHistDefaultLoading, setHistDefaultData);
      if (saved.rFile) fetchChannelHistogram(saved.rFile, "r");
      if (saved.gFile) fetchChannelHistogram(saved.gFile, "g");
      if (saved.bFile) fetchChannelHistogram(saved.bFile, "b");
    }
  } else {
    // First time opening this file
    setSelectedFile(filename);
    setViewMode("raster");
    setHistSelectedRange(null);
    setHistActiveChannel(null);
    setHistDropdownFile(filename);
    setHistDefaultData(null);
    setShowHistogram(false);
    const restoredStretch = getFileStretch(filename);
    setStretchValues(restoredStretch);
    setRFile("");
    setGFile("");
    setBFile("");
    setHistR(null);
    setHistG(null);
    setHistB(null);
    loadImage(buildSingleImageUrl(filename, restoredStretch.default), rasterViewKey(filename));
  }

  if (containerName) {
    setActiveContainer(containerName);
    setActiveRgbContainer(containerName);
  }

  // Metadata (non-blocking)
  const metadataRequestId = loadSequenceRef.current;
  try {
    const res = await axios.get(`${API}/metadata`, { params: { filename } });
    if (metadataRequestId === loadSequenceRef.current) {
      setRasterInfo(res.data);
    }
  } catch (err) {
    // ignore
  }
};

  const handleDeleteRaster = async (e, filename) => {
  e.stopPropagation();
  const displayName = getDisplayName(filename);
  if (!window.confirm(`Delete ${displayName}?`)) return;

  const containerName = getContainerForFile(filename) || activeContainer;
  const wasSelected = selectedFile === filename;
  const wasInRGB = rFile === filename || gFile === filename || bFile === filename;
  const isCurrentlyViewed =
    wasSelected ||
    (viewMode === "rgb" && (rFile === filename || gFile === filename || bFile === filename)) ||
    (viewMode === "swipe" && (swipeLeftFile === filename || swipeRightFile === filename));

  try {
    await axios.delete(`${API}/files/${encodeURIComponent(filename)}`);

    // 1. Remove from containers state
    setContainers((prev) => {
      const updated = {};
      for (const [cName, list] of Object.entries(prev)) {
        const filtered = list.filter((f) => f !== filename);
        if (filtered.length > 0) updated[cName] = filtered;
      }
      return updated;
    });

    // 2. Clean up caches & state
    setFileDisplayNames((prev) => {
      const updated = { ...prev };
      delete updated[filename];
      return updated;
    });

    delete viewStateRef.current[rasterViewKey(filename)];
    delete stretchStateRef.current[filename];
    delete metadataCacheRef.current[filename];
    for (const key of Object.keys(imageHistoryRef.current)) {
      if (key.endsWith(`:${filename}`)) delete imageHistoryRef.current[key];
    }
    for (const key of Object.keys(overviewBlobCacheRef.current)) {
      if (key.includes(encodeURIComponent(filename))) delete overviewBlobCacheRef.current[key];
    }

    if (swipeLeftFile === filename) setSwipeLeftFile("");
    if (swipeRightFile === filename) setSwipeRightFile("");

    // 3. Smart viewport recovery
    if (isCurrentlyViewed && containerName) {
      const remainingFiles = (containers[containerName] || []).filter(
        (f) => f !== filename
      );

      if (remainingFiles.length === 0) {
        // Container is now empty → clear viewport cleanly
        setSelectedFile(null);
        setViewMode("");
        setDisplayedImageUrl("");
        setRasterInfo(null);
        setRFile("");
        setGFile("");
        setBFile("");
        setActiveContainer(null);
        setActiveRgbContainer("");
        if (viewerRef.current) {
          try { viewerRef.current.destroy(); } catch (_) {}
          viewerRef.current = null;
        }
      } else {
        // Automatically switch to another file in the same container
        const nextFile = remainingFiles[0];

        // Prefer keeping RGB if possible
        if (wasInRGB && remainingFiles.length >= 1) {
          recomputeRGBAfterDelete(containerName, filename);
        } else {
          // Switch to single-band view of the next available file
          setTimeout(() => {
            handleSelectRaster(nextFile);
          }, 50);
        }
      }
    } else if (wasInRGB) {
      // File was part of RGB but not the main selected one
      recomputeRGBAfterDelete(containerName, filename);
    }

    showToast(`${displayName} deleted`, "success");
  } catch (err) {
    console.error("Delete failed:", err);
    showToast(`Failed to delete ${displayName}`, "error");
  }
};

  const handleDownload = async () => {
    if (!displayedImageUrl && !isSwipeMode) return;
    if (isSwipeMode) {
      showToast("Download not supported in swipe mode. Switch to standard view.", "error");
      return;
    }
    try {
      const res = await fetch(displayedImageUrl);
      const blob = await res.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const rawName = getDisplayName(selectedFile) || viewMode || "raster";
      const baseName = rawName.replace(/\.(tif|tiff)$/i, "");
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `${baseName}-${viewMode || "view"}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(objectUrl);
    } catch (err) {
      showToast("Download failed.", "error");
    }
  };

const fetchHistogramFor = async (fileKey, setLoading, setData) => {
  if (!fileKey) return;
  const { filename, band } = parseBandKey(fileKey);
  setLoading(true);
  try {
    const res = await axios.get(`${API}/histogram`, {
      params: { filename, band, bins: 32 },
    });
    setData(res.data);
  } catch (err) {
    console.error("Histogram error:", err);
    showToast("Failed to fetch histogram data.", "error");
  } finally {
    setLoading(false);
  }
};
  const fetchChannelHistogram = (filename, channel) => {
    const setLoading =
      channel === "r" ? setHistRLoading :
      channel === "g" ? setHistGLoading : setHistBLoading;
    const setData =
      channel === "r" ? setHistR :
      channel === "g" ? setHistG : setHistB;
    fetchHistogramFor(filename, setLoading, setData);
  };
  
const handleRGBChange = (channel, value) => {
  if (isSwipeMode) return;
  saveCurrentImageHistory();

  // Save current zoom & pan before changing
  let currentViewport = null;
  if (viewerRef.current?.viewport) {
    try {
      const vp = viewerRef.current.viewport;
      const center = vp.getCenter();
      currentViewport = {
        osdZoom: vp.getZoom(),
        osdCenter: { x: center.x, y: center.y },
      };
    } catch (_) {}
  }

  // Update the selected channel
  let nextR = rFile, nextG = gFile, nextB = bFile;
  if (channel === "r") { nextR = value; setRFile(value); }
  if (channel === "g") { nextG = value; setGFile(value); }
  if (channel === "b") { nextB = value; setBFile(value); }

  if (activeContainer) {
    containerRgbRef.current[activeContainer] = { r: nextR, g: nextG, b: nextB };
  }

  // Only load when all three channels are selected
  if (nextR && nextG && nextB) {
    setSelectedFile(null);
    setViewMode("rgb");
    if (activeContainer) setRgbHistoryContext(activeContainer);

    // Keep current stretch values
    const currentStretch = stretchValues;

    loadImage(
      buildCompositeUrl(nextR, nextG, nextB, currentStretch),
      compositeViewKey(nextR, nextG, nextB),
      true,                 // preserve view
      currentViewport       // keep same zoom + pan
    );
  }
};

  const selectHistChannel = (channel) => {
  saveCurrentImageHistory();

  const file = channel === "r" ? rFile : channel === "g" ? gFile : bFile;
  if (!file) {
    showToast(`Select a file for the ${channel.toUpperCase()} channel first.`, "error");
    return;
  }

  // Save current zoom & pan
  let currentViewport = null;
  if (viewerRef.current?.viewport) {
    try {
      const vp = viewerRef.current.viewport;
      const center = vp.getCenter();
      currentViewport = {
        osdZoom: vp.getZoom(),
        osdCenter: { x: center.x, y: center.y },
      };
    } catch (_) {}
  }

  setHistActiveChannel(channel);
  fetchChannelHistogram(file, channel);

  const isRgbComposite = rFile && gFile && bFile;

  if (isRgbComposite) {
    setSelectedFile(null);
    setViewMode("rgb");
    loadImage(
      buildCompositeUrl(rFile, gFile, bFile, stretchValues),
      compositeViewKey(rFile, gFile, bFile),
      true,                 // preserve view
      currentViewport       // keep same zoom + pan
    );
  } else {
    setSelectedFile(file);
    setViewMode("raster");
    loadImage(
      buildSingleImageUrl(file, stretchValues[channel]),
      rasterViewKey(file),
      true,
      currentViewport
    );
  }
};

  const toggleSwipeMode = () => {
    if (isSwipeMode) {
      const previousView = viewBeforeSwipeRef.current;
      setIsSwipeMode(false);
      setIsProfileMode(false);
      if (previousView?.viewMode === "rgb" && previousView.rFile && previousView.gFile && previousView.bFile) {
        setRFile(previousView.rFile);
        setGFile(previousView.gFile);
        setBFile(previousView.bFile);
        setSelectedFile(null);
        setViewMode("rgb");
        setStretchValues(previousView.stretchValues);
        loadImage(
          buildCompositeUrl(previousView.rFile, previousView.gFile, previousView.bFile, previousView.stretchValues),
          compositeViewKey(previousView.rFile, previousView.gFile, previousView.bFile)
        );
      } else if (previousView?.selectedFile) {
        setSelectedFile(previousView.selectedFile);
        setViewMode("raster");
        setStretchValues(previousView.stretchValues);
        loadImage(
          buildSingleImageUrl(previousView.selectedFile, previousView.stretchValues.default),
          rasterViewKey(previousView.selectedFile)
        );
      } else if (previousView?.displayedImageUrl) {
        setDisplayedImageUrl(previousView.displayedImageUrl);
        setViewMode(previousView.viewMode || "raster");
      }
      showToast("Exited Swipe Compare mode", "success");
      return;
    }
    if (activeFilesPool.length < 2) {
      showToast("Need at least 2 rasters in active container for swipe.", "error");
      return;
    }
    viewBeforeSwipeRef.current = {
      selectedFile, viewMode, rFile, gFile, bFile,
      stretchValues: cloneStretchValues(stretchValues),
      displayedImageUrl,
    };
    setIsSwipeMode(true);
    setIsProfileMode(false);
    setSelectedFile(null);
    setViewMode("swipe");
    setSwipeLeftFile(activeFilesPool[0]);
    setSwipeRightFile(activeFilesPool[1] || activeFilesPool[0]);
    setSwipeLeftLoading(true);
    setSwipeRightLoading(true);
    setSwipePosition(50);
    showToast("Swipe Compare mode activated", "success");
  };

  useEffect(() => {
    const handleWindowMouseMove = (e) => {
      if (!isDraggingSwipeDivider || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100));
      setSwipePosition(percentage);
    };
    const handleWindowMouseUp = () => setIsDraggingSwipeDivider(false);
    if (isDraggingSwipeDivider) {
      window.addEventListener("mousemove", handleWindowMouseMove);
      window.addEventListener("mouseup", handleWindowMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
    };
  }, [isDraggingSwipeDivider]);

  useEffect(() => {
    if (!histBoxDrag) return;
    const handleMove = (e) => {
      const clampedX = Math.max(0, Math.min(histBoxDrag.rectWidth, e.clientX - histBoxDrag.rectLeft));
      setHistBoxDrag({ ...histBoxDrag, currentX: clampedX });
    };
    const handleUp = () => {
      const { channel, file, startX, currentX, rectWidth } = histBoxDrag;
      const data =
        channel === "default" ? histDefaultData :
        channel === "r" ? histR :
        channel === "g" ? histG : histB;
      const leftPx = Math.min(startX, currentX);
      const rightPx = Math.max(startX, currentX);
      if (data && file && rectWidth > 0 && rightPx - leftPx > 2) {
        const range = data.max - data.min;
        const rangeMin = Number((data.min + (leftPx / rectWidth) * range).toFixed(3));
        const rangeMax = Number((data.min + (rightPx / rectWidth) * range).toFixed(3));
        setHistSelectedRange({ filename: file, channel, min: rangeMin, max: rangeMax });
        setHistSelectedChannel(channel);
        applyStretchWithValues(channel, rangeMin, rangeMax);
      }
      setHistBoxDrag(null);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [histBoxDrag, histR, histG, histB, histDefaultData]);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) abortControllerRef.current.abort();
      if (activeObjectUrlRef.current) URL.revokeObjectURL(activeObjectUrlRef.current);
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
  if (!isProfileMode || isSwipeMode) return;

  const surface = osdContainerRef.current;
  if (!surface || !viewerRef.current) return;

  const handleClick = (e) => {
    const viewer = viewerRef.current;
    if (!viewer?.viewport) return;

    const rect = surface.getBoundingClientRect();
    const pixel = new OpenSeadragon.Point(
      e.clientX - rect.left,
      e.clientY - rect.top
    );

    const imagePoint = viewer.viewport.viewerElementToImageCoordinates(pixel);
    const point = {
      x: Math.round(imagePoint.x),
      y: Math.round(imagePoint.y),
    };

    if (!profileStart) {
      setProfileStart(point);
      showToast("Start point set. Now click the end point.", "success");
    } else {
      setProfileEnd(point);
      setIsProfileMode(false);

      const fileToUse = profileFile || selectedFile || rFile || (activeFilesPool[0] || "");
      if (fileToUse) {
        fetchProfilePlot(profileStart, point, fileToUse, selectedProfileBand);
      } else {
        showToast("No file selected for profile.", "error");
      }
    }
  };

  surface.style.cursor = "crosshair";
  surface.addEventListener("click", handleClick);

  return () => {
    surface.removeEventListener("click", handleClick);
    surface.style.cursor = "grab";
  };
}, [isProfileMode, profileStart, profileFile, selectedFile, rFile, activeFilesPool, selectedProfileBand]);

  const openHistogramModal = () => {
    if (activeFilesPool.length === 0 && allFilesList.length === 0) {
      return showToast("No files in active container. Select a container first.", "error");
    }

    saveCurrentImageHistory();

    if (viewMode === "rgb" && rFile && gFile && bFile) {
      rgbBeforeHistRef.current = {
        r: rFile,
        g: gFile,
        b: bFile,
        stretch: cloneStretchValues(stretchValues),
      };
    } else {
      rgbBeforeHistRef.current = null;
    }

    const defaultFile =
      (selectedFile && activeFilesPool.includes(selectedFile)) ? selectedFile : activeFilesPool[0];
    if (!defaultFile) return;

    setHistDropdownFile(histDropdownFile || defaultFile);
    setHistActiveChannel(histActiveChannel || null);
    setHistDefaultData(null);
    fetchHistogramFor(histDropdownFile || defaultFile, setHistDefaultLoading, setHistDefaultData);

    setShowHistogram(true);
    setShowScatterPlot(false);
    setShowProfileModal(false);
    setIsProfileMode(false);
  };

  const closeHistogramAndRestore = () => {
    saveCurrentImageHistory();

    setShowHistogram(false);
    setHistActiveChannel(null);
    setHistSelectedRange(null);
    setHistSelectedChannel(null);
  };

  const openScatterPlotModal = () => {
    if (activeFilesPool.length === 0) {
      return showToast("No files in active container. Select a container first.", "error");
    }

    let defaultXFile = rFile || activeFilesPool[0];
    let defaultYFile = gFile || rFile || activeFilesPool[0];

    if (!defaultXFile) defaultXFile = activeFilesPool[0];
    if (!defaultYFile) defaultYFile = defaultXFile;

    setScatterXFile(defaultXFile);
    setScatterYFile(defaultYFile);
    setScatterXBand(1);
    setScatterYBand(1);

    setShowHistogram(false);
    setShowScatterPlot(true);
    setShowProfileModal(false);
    setIsProfileMode(false);

    fetchScatterPlotData(defaultXFile, 1, defaultYFile, 1);
  };

  const fetchScatterPlotData = async (xFile, xBand, yFile, yBand) => {
    if (!xFile || !yFile) return;
    setIsScatterLoading(true);
    try {
      const res = await axios.get(`${API}/scatter-plot`, {
        params: { filename: xFile, x_band: xBand, y_file: yFile, y_band: yBand },
      });
      setScatterData(res.data);
    } catch (err) {
      console.error("Scatter plot error:", err);
      setScatterData({
        points: Array.from({ length: 50 }, () => ({ x: Math.random() * 255, y: Math.random() * 255 })),
        xMin: 0, xMax: 255, yMin: 0, yMax: 255,
      });
    } finally {
      setIsScatterLoading(false);
    }
  };

  const openProfilePlotModal = () => {
  if (activeFilesPool.length === 0) {
    return showToast("No files in active container.", "error");
  }

  const defaultFile = selectedFile || rFile || activeFilesPool[0];
  setProfileFile(defaultFile);
  setSelectedProfileBand(1);
  setProfileStart(null);
  setProfileEnd(null);

  setShowHistogram(false);
  setShowScatterPlot(false);
  setShowProfileModal(false);
  setIsProfileMode(true);

  showToast("Click two points on the image to draw the profile line.", "success");
};

  const fetchProfilePlot = async (pStart, pEnd, filename, band = 1) => {
    if (!filename || !pStart || !pEnd) return;
    setIsProfileLoading(true);
    setShowProfileModal(true);
    try {
      const res = await axios.get(`${API}/profile-plot`, {
        params: { filename, x0: pStart.x, y0: pStart.y, x1: pEnd.x, y1: pEnd.y, band },
      });
      setProfileData(res.data);
    } catch (err) {
      console.error("Profile plot error:", err);
      showToast("Failed to fetch profile data.", "error");
    } finally {
      setIsProfileLoading(false);
    }
  };

  const handleZoomIn = () => {
    const viewer = viewerRef.current;
    if (!viewer?.viewport) return;
    userHasSetViewRef.current = true;
    viewer.viewport.zoomBy(1.25);
    viewer.viewport.applyConstraints();
    saveCurrentImageHistory();
  };

  const handleZoomOut = () => {
    const viewer = viewerRef.current;
    if (!viewer?.viewport) return;
    userHasSetViewRef.current = true;
    viewer.viewport.zoomBy(0.8);
    viewer.viewport.applyConstraints();
    saveCurrentImageHistory();
  };

  const getImageStyle = useMemo(
    () => ({
      ...styles.rasterImageStyle,
      transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
      imageRendering: "auto",
      WebkitImageRendering: "auto",
      msInterpolationMode: "bicubic",
    }),
    [position, scale]
  );

  const renderHistogramBlock = (channelKey, color, label, file, data, loading) => {
    if (loading) return <div style={{ textAlign: "center", padding: "20px", color: "#94a3b8", fontSize: "12px" }}>Loading chart...</div>;
    if (!data) return <div style={{ color: "#64748b", fontSize: "11px", fontStyle: "italic" }}>No histogram data for {label} yet.</div>;
    const stretch = stretchValues[channelKey] || { min: "", max: "" };

    return (
      <div>
        <div style={{ fontSize: "11px", color, fontWeight: 700, marginBottom: "8px" }}>{label} — {getDisplayName(file)}</div>
        <div style={{ fontSize: "10px", color: "#64748b", marginBottom: "6px", fontStyle: "italic" }}>Drag a box across the chart to stretch to that range</div>
        <div
          style={{ position: "relative", userSelect: "none" }}
          onMouseDown={(e) => {
            if (!file) return;
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            const startX = e.clientX - rect.left;
            setHistBoxDrag({ channel: channelKey, file, rectLeft: rect.left, rectWidth: rect.width, startX, currentX: startX });
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-end", height: "90px", gap: "2px", borderBottom: "1px solid #2a2d34", paddingBottom: "2px", marginBottom: "6px", cursor: file ? "crosshair" : "default" }}>
            {data.counts.map((count, idx) => {
              const max = Math.max(...data.counts, 1);
              const pct = Math.max(Math.round((count / max) * 100), 2);
              return (
                <div key={idx} title={`Count: ${count}`} style={{ flex: 1, height: "100%", display: "flex", alignItems: "flex-end", pointerEvents: "none" }}>
                  <div style={{ width: "100%", height: `${pct}%`, backgroundColor: color, borderRadius: "1px 1px 0 0" }} />
                </div>
              );
            })}
          </div>
          {(() => {
            const range = data.max - data.min || 1;
            let leftPct = null;
            let widthPct = null;
            if (histBoxDrag && histBoxDrag.channel === channelKey && histBoxDrag.file === file && histBoxDrag.rectWidth > 0) {
              const leftPx = Math.min(histBoxDrag.startX, histBoxDrag.currentX);
              const rightPx = Math.max(histBoxDrag.startX, histBoxDrag.currentX);
              leftPct = (leftPx / histBoxDrag.rectWidth) * 100;
              widthPct = ((rightPx - leftPx) / histBoxDrag.rectWidth) * 100;
            } else if (histSelectedRange && histSelectedRange.filename === file && histSelectedRange.channel === channelKey) {
              leftPct = ((histSelectedRange.min - data.min) / range) * 100;
              widthPct = ((histSelectedRange.max - histSelectedRange.min) / range) * 100;
            }
            if (leftPct === null) return null;
            return (
              <div
                style={{
                  position: "absolute", top: 0, height: "90px",
                  left: `${Math.max(0, Math.min(100, leftPct))}%`,
                  width: `${Math.max(0.5, Math.min(100 - Math.max(0, leftPct), widthPct))}%`,
                  background: "rgba(59,130,246,0.18)",
                  border: "2px solid rgba(59,130,246,0.9)",
                  borderRadius: "3px",
                  pointerEvents: "none",
                }}
              />
            );
          })()}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: "#64748b", marginBottom: "10px" }}>
          <span>{data.min.toFixed(1)}</span><span>{data.max.toFixed(1)}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "5px", fontSize: "10px", color: "#94a3b8", background: "#14171d", padding: "6px 8px", borderRadius: "4px", border: "1px solid #1e222d" }}>
          <div>Min: {data.min.toFixed(2)}</div>
          <div>Max: {data.max.toFixed(2)}</div>
          <div>Mean: {data.mean.toFixed(2)}</div>
          <div>Std Dev: {data.std.toFixed(2)}</div>
        </div>
        <div style={{ marginTop: "10px", padding: "8px", background: "#0b0d11", borderRadius: "5px", border: "1px solid #1e222d" }}>
          <div style={{ fontSize: "10px", color: "#94a3b8", marginBottom: "6px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em" }}>Linear Contrast Stretch</div>
          <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
            <input type="number" placeholder={`Min (${data.min.toFixed(1)})`} value={stretch.min} onChange={(e) => updateStretchInput(channelKey, "min", e.target.value)} style={styles.stretchInput} />
            <input type="number" placeholder={`Max (${data.max.toFixed(1)})`} value={stretch.max} onChange={(e) => updateStretchInput(channelKey, "max", e.target.value)} style={styles.stretchInput} />
          </div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            <button style={styles.stretchBtn} onClick={() => applyAutoStretch(channelKey, 2, 98)} title="Auto 2–98%">Auto 2–98%</button>
            <button style={styles.stretchBtn} onClick={() => applyAutoStretch(channelKey, 0, 100)} title="Min–Max">Min–Max</button>
            <button style={{ ...styles.stretchBtn, background: "#2563eb", borderColor: "#2563eb" }} onClick={() => applyStretch(channelKey)}>Apply</button>
            <button style={{ ...styles.stretchBtn, color: "#f87171" }} onClick={() => resetStretch(channelKey)} title="Remove stretch">Reset</button>
          </div>
          {(stretch.min !== "" || stretch.max !== "") && (
            <div style={{ fontSize: "10px", color: "#38bdf8", marginTop: "6px" }}>
              Stretching {stretch.min !== "" ? stretch.min : data.min.toFixed(1)} → {stretch.max !== "" ? stretch.max : data.max.toFixed(1)}
            </div>
          )}

          {(stretch.min !== "" || stretch.max !== "") && (
            <div
              style={{
                marginTop: "12px",
                padding: "8px",
                background: "#0b0d11",
                borderRadius: "5px",
                border: "1px solid #1e222d",
              }}
            >
              <div
                style={{
                  fontSize: "10px",
                  color: "#94a3b8",
                  marginBottom: "6px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.03em",
                }}
              >
                Stretched Histogram ({channelKey === "default" ? "Image" : channelKey.toUpperCase()})
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  height: "60px",
                  gap: "2px",
                  borderBottom: "1px solid #2a2d34",
                  paddingBottom: "2px",
                  marginBottom: "6px",
                }}
              >
                {data.counts.map((count, idx) => {
                  const max = Math.max(...data.counts, 1);
                  const pct = Math.max(Math.round((count / max) * 100), 2);
                  const binCount = data.counts.length;
                  const binWidth = (data.max - data.min) / binCount;
                  const binMin = data.min + idx * binWidth;
                  const binMax = idx === binCount - 1 ? data.max : data.min + (idx + 1) * binWidth;

                  const sMin = stretch.min !== "" ? Number(stretch.min) : data.min;
                  const sMax = stretch.max !== "" ? Number(stretch.max) : data.max;

                  const visible = binMax > sMin && binMin < sMax;
                  const opacity = visible ? 1 : 0.15;

                  return (
                    <div
                      key={`stretched-${channelKey}-${idx}`}
                      title={`Count: ${count} | ${binMin.toFixed(1)}–${binMax.toFixed(1)}`}
                      style={{
                        flex: 1,
                        height: "100%",
                        display: "flex",
                        alignItems: "flex-end",
                        pointerEvents: "none",
                      }}
                    >
                      <div
                        style={{
                          width: "100%",
                          height: `${pct}%`,
                          backgroundColor: color,
                          borderRadius: "1px 1px 0 0",
                          opacity,
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, 1fr)",
                  gap: "5px",
                  fontSize: "10px",
                  color: "#94a3b8",
                  background: "#14171d",
                  padding: "6px 8px",
                  borderRadius: "4px",
                  border: "1px solid #1e222d",
                }}
              >
                <div>
                  Min:{" "}
                  {stretch.min !== "" ? Number(stretch.min).toFixed(2) : data.min.toFixed(2)}
                </div>
                <div>
                  Max:{" "}
                  {stretch.max !== "" ? Number(stretch.max).toFixed(2) : data.max.toFixed(2)}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={styles.appContainer}>
      <div style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          <h2 style={styles.sidebarTitle}>GeoTIFF Studio</h2>
          <span style={styles.versionBadge}>v2.0</span>
        </div>
        <label style={styles.uploadBtn}>
          <span>📥 Import Rasters</span>
          <input type="file" multiple accept=".tif,.tiff" onChange={handleFileSelectInput} style={{ display: "none" }} />
        </label>

        <div style={styles.sectionHeader}>
          Containers & Datasets <span style={styles.badge}>{allFilesList.length}</span>
        </div>
        <div style={styles.rasterList}>
          {Object.keys(containers).length === 0 ? (
            <div style={styles.emptyStateText}>No containers or rasters loaded.</div>
          ) : (
            Object.entries(containers).map(([containerName, files]) => {
              const isContainerActive = activeContainer === containerName;
              return (
                <div
                  key={containerName}
                  style={{
                    ...styles.containerGroup,
                    borderColor: isContainerActive ? "#38bdf8" : "#1e222d",
                    background: isContainerActive ? "#0f172a" : "transparent",
                  }}
                >
                  <div
                    style={{
                      ...styles.containerHeaderBar,
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                    onClick={() => {
  saveCurrentImageHistory();
  setActiveContainer(containerName);
  setActiveRgbContainer(containerName);
  setHistActiveChannel(null);
  setHistDropdownFile("");
  setShowHistogram(false);

  const filesInContainer = containers[containerName] || [];
  if (filesInContainer.length === 0) return;

  const saved = getSavedRgbHistory(containerName);
  setRgbHistoryContext(containerName);

  const savedCombo = saved && saved.rFile && saved.gFile && saved.bFile &&
    filesInContainer.includes(saved.rFile) &&
    filesInContainer.includes(saved.gFile) &&
    filesInContainer.includes(saved.bFile)
    ? saved
    : null;

  let r, g, b, stretchToUse, restoreViewport;

  if (savedCombo) {
    // Restore exactly the R/G/B bands, stretch, and zoom/pan this
    // container's composite had the last time it was viewed — this is
    // the fix: previously every click here reset to files[0..2] with no
    // stretch and no zoom/pan restore, no matter what was saved.
    r = savedCombo.rFile;
    g = savedCombo.gFile;
    b = savedCombo.bFile;
    stretchToUse = cloneStretchValues(savedCombo.stretchValues);
    restoreViewport = savedCombo;
  } else {
    // First time viewing this container's composite — default to the
    // first three (or fewer) files, with no stretch applied yet.
    if (filesInContainer.length === 1) {
      r = g = b = filesInContainer[0];
    } else if (filesInContainer.length === 2) {
      r = filesInContainer[0];
      g = filesInContainer[1];
      b = filesInContainer[1];
    } else {
      r = filesInContainer[0];
      g = filesInContainer[1];
      b = filesInContainer[2];
    }
    stretchToUse = createEmptyStretchValues();
    restoreViewport = null;
  }

  setRFile(r);
  setGFile(g);
  setBFile(b);
  setSelectedFile(null);
  setViewMode("rgb");
  setStretchValues(stretchToUse);

  containerRgbRef.current[containerName] = { r, g, b };

  loadImage(
    buildCompositeUrl(r, g, b, stretchToUse),
    compositeViewKey(r, g, b),
    true,
    restoreViewport
  );
}}
                  >
                    <span style={{ flex: 1 }}>
                      📦 {containerName} {isContainerActive && "(Active)"}
                    </span>
                    <span style={styles.badge}>{files.length}</span>
                  </div>

                  {files.map((filePath) => {
                    const fileName = getDisplayFilename(filePath);
                    const isSelected = selectedFile === filePath;
                    return (
                      <div
                        key={filePath}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isSwipeMode) return;
                          setActiveContainer(containerName);
                          setActiveRgbContainer(containerName);
                          handleSelectRaster(filePath);
                        }}
                        style={{
                          ...styles.rasterCard,
                          borderColor: isSelected ? "#2563eb" : "#2a2d34",
                          background: isSelected ? "#1e293b" : "#14171d",
                          gridTemplateColumns: "1fr 26px",
                        }}
                      >
                        <div style={styles.rasterInfoText} title={fileName}>
                          <div style={styles.rasterName}>{fileName}</div>
                          <div style={styles.rasterSubtext}>GeoTIFF Dataset</div>
                        </div>
                        <button
                          style={styles.deleteBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteRaster(e, filePath);
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}

                  <button
                    style={{
                      alignSelf: "flex-end",
                      background: "none",
                      border: "1px solid #efe6e6",
                      color: "#ecdada",
                      cursor: "pointer",
                      fontSize: "11px",
                      padding: "2px 6px",
                      borderRadius: "4px",
                      marginTop: "4px",
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteContainer(containerName);
                    }}
                    title={`Delete ${containerName}`}
                  >
                    ✕
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div style={styles.mainContent}>
        <div style={styles.toolbar}>
          <div style={styles.toolGroup}>
            <span style={styles.groupLabel}>Navigation</span>
            <div style={styles.btnRow}>
              <button style={styles.iconBtn} onClick={handleZoomIn}>🔍 +</button>
              <button style={styles.iconBtn} onClick={handleZoomOut}>🔍 -</button>
              <button style={{ ...styles.iconBtn, color: "#f87171" }} onClick={resetView}>🎯 Reset</button>
              <button style={{ ...styles.iconBtn, background: showMinimap ? "#2563eb" : "#1e222d" }} onClick={() => setShowMinimap((s) => !s)}>🗺️ Minimap</button>
            </div>
          </div>
          <div style={styles.divider} />
          <div style={styles.toolGroup}>
            <span style={styles.groupLabel}>Compare</span>
            <div style={styles.btnRow}>
              <button style={{ ...styles.iconBtn, background: isSwipeMode ? "#2563eb" : "#1e222d", color: isSwipeMode ? "#ffffff" : "#e2e8f0" }} onClick={toggleSwipeMode}>🔀 Swipe Compare</button>
            </div>
          </div>
          <div style={styles.divider} />
          <div style={styles.toolGroup}>
            <span style={styles.groupLabel}>Analysis</span>
            <div style={styles.btnRow}>
              <button style={{ ...styles.iconBtn, opacity: activeFilesPool.length > 0 && !isSwipeMode ? 1 : 0.4 }} onClick={openHistogramModal} disabled={activeFilesPool.length === 0 || isSwipeMode}>📊 Histogram</button>
              <button style={{ ...styles.iconBtn, opacity: activeFilesPool.length > 0 && !isSwipeMode ? 1 : 0.4 }} onClick={openScatterPlotModal} disabled={activeFilesPool.length === 0 || isSwipeMode}>📈 Scatter Plot</button>
              <button style={{ ...styles.iconBtn, background: isProfileMode ? "#0d9488" : "#1e222d", opacity: activeFilesPool.length > 0 && !isSwipeMode ? 1 : 0.4 }} onClick={() => { if (activeFilesPool.length === 0 || isSwipeMode) return; if (isProfileMode) { setIsProfileMode(false); showToast("Profile mode canceled", "success"); } else { openProfilePlotModal(); } }} disabled={activeFilesPool.length === 0 || isSwipeMode}>📉 Profile Plot</button>
            </div>
          </div>
          <div style={styles.divider} />
          <div style={styles.toolGroup}>
            <span style={styles.groupLabel}>RGB Composite ({activeContainer || "Select Container"})</span>
            <div style={styles.btnRow}>
              <div style={styles.selectPair}>
                <span style={{ color: "#ef4444", fontWeight: 700 }}>R</span>
                <select style={styles.selectInput} value={rFile} onChange={(e) => handleRGBChange("r", e.target.value)} disabled={!activeContainer || isSwipeMode}>
                  <option value="">Band...</option>
                  {activeFilesPool.map((f) => <option key={`r-${f}`} value={f}>{getDisplayName(f)}</option>)}
                </select>
                {isImageLoading && <span style={styles.inlineSpinner} />}
              </div>
              <div style={styles.selectPair}>
                <span style={{ color: "#22c55e", fontWeight: 700 }}>G</span>
                <select style={styles.selectInput} value={gFile} onChange={(e) => handleRGBChange("g", e.target.value)} disabled={!activeContainer || isSwipeMode}>
                  <option value="">Band...</option>
                  {activeFilesPool.map((f) => <option key={`g-${f}`} value={f}>{getDisplayName(f)}</option>)}
                </select>
                {isImageLoading && <span style={styles.inlineSpinner} />}
              </div>
              <div style={styles.selectPair}>
                <span style={{ color: "#3b82f6", fontWeight: 700 }}>B</span>
                <select style={styles.selectInput} value={bFile} onChange={(e) => handleRGBChange("b", e.target.value)} disabled={!activeContainer || isSwipeMode}>
                  <option value="">Band...</option>
                  {activeFilesPool.map((f) => <option key={`b-${f}`} value={f}>{getDisplayName(f)}</option>)}
                </select>
                {isImageLoading && <span style={styles.inlineSpinner} />}
              </div>
            </div>
          </div>
          <div style={styles.divider} />
          <div style={styles.toolGroup}>
            <span style={styles.groupLabel}>Export</span>
            <div style={styles.btnRow}>
              <button style={{ ...styles.iconBtn, opacity: displayedImageUrl && !isSwipeMode ? 1 : 0.4 }} onClick={handleDownload} disabled={!displayedImageUrl || isSwipeMode}>⬇ Download</button>
            </div>
          </div>
        </div>

        {isSwipeMode && (
          <div style={styles.metaStrip}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ color: "#38bdf8", fontWeight: 600 }}>Left Layer:</span>
              <select value={swipeLeftFile} onChange={(e) => { setSwipeLeftLoading(true); setSwipeLeftFile(e.target.value); }} style={styles.selectInput}>
                {activeFilesPool.map((f) => <option key={`sw-l-${f}`} value={f}>{getDisplayName(f)}</option>)}
              </select>
              {swipeLeftLoading && <span style={styles.inlineSpinner} />}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ color: "#38bdf8", fontWeight: 600 }}>Right Layer:</span>
              <select value={swipeRightFile} onChange={(e) => { setSwipeRightLoading(true); setSwipeRightFile(e.target.value); }} style={styles.selectInput}>
                {activeFilesPool.map((f) => <option key={`sw-r-${f}`} value={f}>{getDisplayName(f)}</option>)}
              </select>
              {swipeRightLoading && <span style={styles.inlineSpinner} />}
            </div>
            <span><strong>Zoom:</strong> {Math.round(scale * 100)}%</span>
          </div>
        )}

        {!isSwipeMode && rasterInfo && (
          <div style={styles.metaStrip}>
            <span><strong>Layer:</strong> {getDisplayName(selectedFile) || rasterInfo.filename}</span>
            <span><strong>Container:</strong> {getContainerForFile(selectedFile) || "None"}</span>
            <span><strong>Size:</strong> {rasterInfo.width} × {rasterInfo.height}</span>
            <span><strong>Bands:</strong> {rasterInfo.bands}</span>
            <span><strong>Zoom:</strong> {Math.round(scale * 100)}%</span>
          </div>
        )}

        <div ref={containerRef} style={{ ...styles.viewport, position: "relative", overflow: "hidden" }}>
          {isSwipeMode ? (
            <div style={{ position: "relative", width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
              <div style={{ position: "absolute", width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <img src={`${API}/image?filename=${encodeURIComponent(swipeRightFile)}`} alt="Right Layer" draggable={false} style={getImageStyle} onLoad={() => setSwipeRightLoading(false)} onError={() => setSwipeRightLoading(false)} />
              </div>
              <div style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: `${swipePosition}%`, overflow: "hidden", pointerEvents: "none" }}>
                <div style={{ position: "absolute", top: 0, left: 0, width: containerRef.current ? `${containerRef.current.clientWidth}px` : "100vw", height: containerRef.current ? `${containerRef.current.clientHeight}px` : "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <img src={`${API}/image?filename=${encodeURIComponent(swipeLeftFile)}`} alt="Left Layer" draggable={false} style={getImageStyle} onLoad={() => setSwipeLeftLoading(false)} onError={() => setSwipeLeftLoading(false)} />
                </div>
              </div>
              <div onMouseDown={(e) => { e.stopPropagation(); setIsDraggingSwipeDivider(true); }} style={{ position: "absolute", top: 0, bottom: 0, left: `${swipePosition}%`, width: "4px", backgroundColor: "#38bdf8", cursor: "ew-resize", transform: "translateX(-50%)", zIndex: 5, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div style={{ width: "24px", height: "24px", borderRadius: "50%", backgroundColor: "#38bdf8", color: "#0b0d11", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "10px", fontWeight: "bold", boxShadow: "0 2px 6px rgba(0,0,0,0.5)" }}>↔</div>
              </div>
            </div>
          ) : (
            <>
              {displayedImageUrl && showOverviewInViewport && (
                <img
                  src={displayedImageUrl}
                  alt="raster overview"
                  draggable={false}
                  onError={(e) => { e.currentTarget.style.display = "none"; }}
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    objectPosition: "center",
                    zIndex: 5,
                    pointerEvents: "none",
                    userSelect: "none",
                  }}
                />
              )}
              <div
                id="osd-viewer"
                ref={osdContainerRef}
                style={{ position: "absolute", inset: 0, background: "#07090c", zIndex: 10 }}
              />
            </>
          )}
          {isImageLoading && !isSwipeMode && (
            <div style={styles.loadingBadge}>
              <div style={styles.spinnerSmall} /><span>Loading image…</span>
            </div>
          )}
          {!isSwipeMode && displayedImageUrl && showMinimap && (
            <div
              title="Click to move viewport to this location"
              onClick={(e) => {
                const viewer = viewerRef.current;
                if (!viewer?.viewport || !currentRasterSizeRef.current.width || !currentRasterSizeRef.current.height) return;

                const box = e.currentTarget.getBoundingClientRect();
                const clickX = e.clientX - box.left;
                const clickY = e.clientY - box.top;
                const rasterWidth = currentRasterSizeRef.current.width;
                const rasterHeight = currentRasterSizeRef.current.height;

                const boxAspect = box.width / box.height;
                const rasterAspect = rasterWidth / rasterHeight;
                let renderedWidth = box.width;
                let renderedHeight = box.height;
                let offsetX = 0;
                let offsetY = 0;

                if (rasterAspect > boxAspect) {
                  renderedHeight = box.width / rasterAspect;
                  offsetY = (box.height - renderedHeight) / 2;
                } else {
                  renderedWidth = box.height * rasterAspect;
                  offsetX = (box.width - renderedWidth) / 2;
                }

                if (
                  clickX < offsetX ||
                  clickX > offsetX + renderedWidth ||
                  clickY < offsetY ||
                  clickY > offsetY + renderedHeight
                ) return;

                const imageX = ((clickX - offsetX) / renderedWidth) * rasterWidth;
                const imageY = ((clickY - offsetY) / renderedHeight) * rasterHeight;

                const target = viewer.viewport.imageToViewportCoordinates(imageX, imageY);
                viewer.viewport.panTo(target, true);
                viewer.viewport.applyConstraints();
                userHasSetViewRef.current = true;
                updateMiniRectFromViewer(rasterWidth, rasterHeight, viewer);
                saveCurrentImageHistory();
              }}
              style={{ ...styles.minimapContainer, right: (showHistogram || showScatterPlot || showProfileModal) ? "378px" : "18px", cursor: "crosshair" }}
            >
              <img src={displayedImageUrl} alt="minimap" style={styles.minimapImage} draggable={false} />
              <div style={{ ...styles.miniViewportRect, left: `${miniRect.left * 100}%`, top: `${miniRect.top * 100}%`, width: `${Math.max(miniRect.width * 100, 1)}%`, height: `${Math.max(miniRect.height * 100, 1)}%` }} />
            </div>
          )}
        </div>
      </div>

      {showContainerModal && (
        <div style={styles.modalBackdrop}>
          <div style={styles.modalBox}>
            <h3 style={styles.modalTitle}>Choose Storage Container</h3>
            <p style={styles.modalSubtitle}>Select an existing container or create a new one for your files.</p>
            <div style={styles.modalContainerList}>
              {Object.keys(containers).map((cName) => (
                <button key={cName} style={styles.modalOptionBtn} onClick={() => processUploadsToContainer(cName, pendingFiles)}>
                  📁 {cName} ({containers[cName].length} files)
                </button>
              ))}
              <button style={{ ...styles.modalOptionBtn, backgroundColor: "#2563eb", color: "#fff", borderColor: "#2563eb" }} onClick={() => { const newName = getNextContainerName(); processUploadsToContainer(newName, pendingFiles); }}>
                ➕ Create New Container ({getNextContainerName()})
              </button>
            </div>
            <button style={styles.modalCancelBtn} onClick={() => { setShowContainerModal(false); setPendingFiles([]); }}>Cancel</button>
          </div>
        </div>
      )}

      {showHistogram && (
        <div style={styles.histPanel}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h3 style={{ margin: 0, fontSize: "14px", color: "#f8fafc" }}>Pixel Distribution (Histogram)</h3>
            <button style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: "16px" }} onClick={closeHistogramAndRestore}>✕</button>
          </div>
          <div style={{ fontSize: "11px", color: "#64748b", marginBottom: "10px" }}>
            Container: <strong style={{ color: "#38bdf8" }}>{activeContainer || "None"}</strong>
          </div>
          <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
            {[{ ch: "r", color: "#ef4444", file: rFile }, { ch: "g", color: "#22c55e", file: gFile }, { ch: "b", color: "#3b82f6", file: bFile }].map(({ ch, color, file }) => (
              <div key={ch} style={{ flex: 1, textAlign: "center" }}>
                <button onClick={() => selectHistChannel(ch)} style={{ width: "100%", padding: "8px", borderRadius: "6px", fontWeight: 700, fontSize: "13px", cursor: "pointer", background: histActiveChannel === ch ? color : "#1e222d", color: histActiveChannel === ch ? "#0b0d11" : color, border: `1px solid ${color}` }}>
                  {ch.toUpperCase()}
                </button>
                <div style={{ fontSize: "9px", color: "#64748b", marginTop: "4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {file ? getDisplayName(file) : "—"}
                </div>
              </div>
            ))}
          </div>
          {histSelectedRange && typeof histSelectedRange.min === "number" && typeof histSelectedRange.max === "number" && (
            <div style={{ fontSize: "11px", color: "#a5b4fc", marginBottom: "14px", padding: "10px", background: "rgba(59,130,246,0.08)", borderRadius: "6px", border: "1px solid rgba(59,130,246,0.18)" }}>
              Selected range: <strong>{histSelectedRange.channel === "default" ? "Selected Image" : histSelectedRange.channel.toUpperCase()}</strong> on <strong>{getDisplayName(histSelectedRange.filename)}</strong>
              <br />
              Values: {histSelectedRange.min.toFixed(2)} – {histSelectedRange.max.toFixed(2)}
            </div>
          )}
          {histActiveChannel === null && renderHistogramBlock("default", "#38bdf8", "Selected Image", histDropdownFile, histDefaultData, histDefaultLoading)}
          {histActiveChannel === "r" && renderHistogramBlock("r", "#ef4444", "Red Channel", rFile, histR, histRLoading)}
          {histActiveChannel === "g" && renderHistogramBlock("g", "#22c55e", "Green Channel", gFile, histG, histGLoading)}
          {histActiveChannel === "b" && renderHistogramBlock("b", "#3b82f6", "Blue Channel", bFile, histB, histBLoading)}
        </div>
      )}

      {showScatterPlot && (
        <div style={{ ...styles.sidePanel, right: showHistogram ? "360px" : 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h3 style={{ margin: 0, fontSize: "14px", color: "#f8fafc" }}>Band Scatter Plot Correlation</h3>
            <button style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer" }} onClick={() => setShowScatterPlot(false)}>✕</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <label style={{ fontSize: "11px", color: "#94a3b8", width: "50px" }}>X-Axis:</label>
              <select value={scatterXFile} onChange={(e) => { const f = e.target.value; setScatterXFile(f); fetchScatterPlotData(f, scatterXBand, scatterYFile, scatterYBand); }} style={{ ...styles.selectInput, flex: 1 }}>
                {activeFilesPool.map((f) => <option key={`sx-${f}`} value={f}>{getDisplayName(f)}</option>)}
              </select>
              <select value={scatterXBand} onChange={(e) => { const b = Number(e.target.value); setScatterXBand(b); fetchScatterPlotData(scatterXFile, b, scatterYFile, scatterYBand); }} style={styles.selectInput}>
                <option value={1}>Band 1</option>
              </select>
              {isScatterLoading && <span style={styles.inlineSpinner} />}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <label style={{ fontSize: "11px", color: "#94a3b8", width: "50px" }}>Y-Axis:</label>
              <select value={scatterYFile} onChange={(e) => { const f = e.target.value; setScatterYFile(f); fetchScatterPlotData(scatterXFile, scatterXBand, f, scatterYBand); }} style={{ ...styles.selectInput, flex: 1 }}>
                {activeFilesPool.map((f) => <option key={`sy-${f}`} value={f}>{getDisplayName(f)}</option>)}
              </select>
              <select value={scatterYBand} onChange={(e) => { const b = Number(e.target.value); setScatterYBand(b); fetchScatterPlotData(scatterXFile, scatterXBand, scatterYFile, b); }} style={styles.selectInput}>
                <option value={1}>Band 1</option>
              </select>
              {isScatterLoading && <span style={styles.inlineSpinner} />}
            </div>
          </div>
          {isScatterLoading ? (
            <div style={{ textAlign: "center", padding: "40px", color: "#94a3b8", fontSize: "12px" }}>Computing scatter plot...</div>
          ) : scatterData && scatterData.points ? (
            <div>
              <div style={{ position: "relative", width: "100%", height: "200px", background: "#14171d", border: "1px solid #2a2d34", borderRadius: "6px", overflow: "hidden" }}>
                {scatterData.points.map((pt, idx) => {
                  const left = Math.min(Math.max((pt.x / (scatterData.xMax || 255)) * 100, 2), 98);
                  const bottom = Math.min(Math.max((pt.y / (scatterData.yMax || 255)) * 100, 2), 98);
                  return (
                    <div key={idx} style={{ position: "absolute", left: `${left}%`, bottom: `${bottom}%`, width: "4px", height: "4px", backgroundColor: "#38bdf8", borderRadius: "50%", transform: "translate(-50%, 50%)", opacity: 0.7 }} />
                  );
                })}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: "#64748b", marginTop: "6px" }}>
                <span>X Values</span><span>Y Values</span>
              </div>
            </div>
          ) : (
            <div style={{ color: "#ef4444", fontSize: "12px" }}>No scatter data returned</div>
          )}
        </div>
      )}

      {showProfileModal && (
        <div style={{ ...styles.sidePanel, right: showHistogram ? "360px" : 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
    