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

// Tile pyramid constants — must match the backend's TILE_SIZE / level
// convention exactly (level 0 = whole image in ~1 tile, level == maxLevel
// = full native resolution, doubling each level in between).
const TILE_SIZE = 256;

const computeMaxLevel = (width, height) => {
  const maxDim = Math.max(width, height, 1);
  return Math.max(0, Math.ceil(Math.log2(Math.max(maxDim / TILE_SIZE, 1))));
};

async function uploadFileChunked(file, containerName, onProgress) {
  const CHUNK_SIZE = 4 * 1024 * 1024;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let completed = 0;
  const indices = [...Array(totalChunks).keys()];

  async function uploadOneChunk() {
    while (indices.length > 0) {
      const index = indices.shift();
      if (index === undefined) break;

      const start = index * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      const chunk = file.slice(start, end);

      const formData = new FormData();
      formData.append("file", chunk, file.name);
      formData.append("upload_id", uploadId);
      formData.append("chunk_index", String(index));

      let retries = 3;
      let success = false;

      while (retries > 0 && !success) {
        try {
          const chunkResponse = await fetch(`${API}/upload-chunk`, {
            method: "POST",
            body: formData,
          });
          if (!chunkResponse.ok) {
            const errorText = await chunkResponse.text();
            throw new Error(`Chunk ${index} failed: ${chunkResponse.status} ${errorText}`);
          }
          success = true;
        } catch (error) {
          retries -= 1;
          if (retries === 0) {
            throw new Error(`Chunk ${index} failed after retries: ${error.message}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      completed += 1;
      if (onProgress) onProgress(Math.round((completed / totalChunks) * 100));
    }
  }

  const workers = Array(Math.min(3, totalChunks)).fill(null).map(() => uploadOneChunk());
  await Promise.all(workers);

  const completeForm = new FormData();
  completeForm.append("upload_id", uploadId);
  completeForm.append("filename", file.name);
  completeForm.append("total_chunks", String(totalChunks));
  completeForm.append("container_name", containerName);

  const completeResponse = await fetch(`${API}/upload-complete`, {
    method: "POST",
    body: completeForm,
  });

  if (!completeResponse.ok) {
    const errorText = await completeResponse.text();
    throw new Error(`Upload finalization failed: ${completeResponse.status} ${errorText}`);
  }

  return completeResponse.json();
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
  const [viewMode, setViewMode] = useState("");
  const [toast, setToast] = useState(null);


  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });


  const [miniRect, setMiniRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [showMinimap, setShowMinimap] = useState(true);


  const containerRef = useRef(null);
  const imgRef = useRef(null);
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

  const containerRgbRef = useRef({});
  const containerStretchRef = useRef({});
  const containerViewStateRef = useRef({});


  const userHasSetViewRef = useRef(false);


  const getHistoryKey = (containerName, filename) => {
    if (!containerName || !filename) return null;
    return `image:${containerName}:${filename}`;
  };


  const saveCurrentImageHistory = () => {
    const context = historyContextRef.current;
    if (!context?.key) return;
    imageHistoryRef.current[context.key] = {
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

// Builds (or rebuilds) the real OpenSeadragon deep-zoom viewport from a
// resolved set of tile parameters. This is what actually makes the
// viewport show tiles — the whole image renders from a handful of
// low-res tiles almost immediately, and OSD automatically requests
// higher-resolution tiles (via /api/tile or /api/rgb-tile) for whatever
// region you zoom into, swapping them in as they arrive.
const buildAndShowTiles = async (tileParams) => {
  if (viewerRef.current) {
    viewerRef.current.destroy();
    viewerRef.current = null;
  }
  if (!osdContainerRef.current) return;

  const metaFile = tileParams.type === "rgb" ? tileParams.r : tileParams.file;
  if (!metaFile) return;

  setIsImageLoading(true);

  try {
    const res = await axios.get(`${API}/metadata`, { params: { filename: metaFile } });
    const { width, height } = res.data;
    if (!osdContainerRef.current) return; // unmounted / swiped away mid-fetch

    const maxLevel = computeMaxLevel(width, height);

    const buildRasterTileUrl = (level, x, y) => {
      let url = `${API}/tile?filename=${encodeURIComponent(tileParams.file)}&z=${level}&x=${x}&y=${y}`;
      if (tileParams.min !== "" && tileParams.min != null) url += `&min_val=${encodeURIComponent(tileParams.min)}`;
      if (tileParams.max !== "" && tileParams.max != null) url += `&max_val=${encodeURIComponent(tileParams.max)}`;
      return url;
    };

    const buildRgbTileUrl = (level, x, y) => {
      let url = `${API}/rgb-tile?r_file=${encodeURIComponent(tileParams.r)}&g_file=${encodeURIComponent(tileParams.g)}&b_file=${encodeURIComponent(tileParams.b)}&z=${level}&x=${x}&y=${y}`;
      [["r_min", tileParams.rMin], ["r_max", tileParams.rMax], ["g_min", tileParams.gMin], ["g_max", tileParams.gMax], ["b_min", tileParams.bMin], ["b_max", tileParams.bMax]].forEach(([key, val]) => {
        if (val !== "" && val != null) url += `&${key}=${encodeURIComponent(val)}`;
      });
      return url;
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
      gestureSettingsMouse: { clickToZoom: false },
    });

    viewerRef.current.addOnceHandler("open", () => setIsImageLoading(false));
    viewerRef.current.addOnceHandler("open-failed", () => {
      setIsImageLoading(false);
      showToast("Failed to load image tiles.", "error");
    });
  } catch (err) {
    console.error("Failed to load tile metadata:", err);
    setIsImageLoading(false);
    showToast("Failed to load image metadata.", "error");
  }
};

const loadImage = (url, viewKey = null, preserveView = false) => {
  if (abortControllerRef.current) abortControllerRef.current.abort();
  if (activeObjectUrlRef.current) {
    URL.revokeObjectURL(activeObjectUrlRef.current);
    activeObjectUrlRef.current = null;
  }
  abortControllerRef.current = new AbortController();
  setImageUrl(url);
  setIsImageLoading(true);

  // Derive tile parameters from the same URL used for the flat preview
  // (used for the minimap thumbnail below) and drive the real tiled
  // OpenSeadragon viewport from them. This piggybacks on every existing
  // call site of loadImage (select raster, apply stretch, switch RGB
  // channel, switch container, exit swipe mode, etc.) without needing to
  // touch each of them individually.
  try {
    const parsed = new URL(url);
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
      });
    } else if (parsed.pathname.endsWith("/image")) {
      buildAndShowTiles({
        type: "raster",
        file: parsed.searchParams.get("filename"),
        min: parsed.searchParams.get("min_val"),
        max: parsed.searchParams.get("max_val"),
      });
    }
  } catch (err) {
    console.error("Failed to derive tile source from URL:", err);
  }

    const preloader = new Image();
    preloader.onload = (e) => {
      setDisplayedImageUrl(url);
      setIsImageLoading(false);
      currentViewKeyRef.current = viewKey;


      const shouldAutoFit =
        !userHasSetViewRef.current &&
        scale === 1 &&
        position.x === 0 &&
        position.y === 0 &&
        containerRef.current;


      if (shouldAutoFit && containerRef.current) {
        const cw = containerRef.current.clientWidth;
        const ch = containerRef.current.clientHeight;
        const iw = e.target.naturalWidth;
        const ih = e.target.naturalHeight;
        if (iw > 0 && ih > 0) {
          const ratio = Math.min(cw / iw, ch / ih) * 0.95;
          setScale(Math.max(MIN_SCALE, Math.min(ratio, 1)));
          setPosition({ x: 0, y: 0 });
        }
      }
    };
    preloader.src = url;
  };

  // Tear down the OSD viewer whenever swipe mode is entered — its
  // container div gets unmounted while in swipe mode, so the viewer
  // instance must not be left pointing at a detached element.
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
      if (!imgRef.current || !containerRef.current) return;
      const imgRect = imgRef.current.getBoundingClientRect();
      const contRect = containerRef.current.getBoundingClientRect();
      const visLeft = Math.max(0, contRect.left - imgRect.left);
      const visTop = Math.max(0, contRect.top - imgRect.top);
      const visRight = Math.max(0, Math.min(imgRect.width, contRect.right - imgRect.left));
      const visBottom = Math.max(0, Math.min(imgRect.height, contRect.bottom - imgRect.top));
      const visW = Math.max(0, visRight - visLeft);
      const visH = Math.max(0, visBottom - visTop);
      const leftPct = visLeft / Math.max(imgRect.width, 1);
      const topPct = visTop / Math.max(imgRect.height, 1);
      const widthPct = visW / Math.max(imgRect.width, 1);
      const heightPct = visH / Math.max(imgRect.height, 1);
      setMiniRect({ left: leftPct, top: topPct, width: widthPct, height: heightPct });
    };
    updateMini();
    window.addEventListener("resize", updateMini);
    return () => window.removeEventListener("resize", updateMini);
  }, [displayedImageUrl, scale, position, isDragging, isSwipeMode]);


  const buildSingleImageUrl = (filename, stretch) => {
    let url = `${API}/image?filename=${encodeURIComponent(filename)}`;
    if (stretch && stretch.min !== "" && stretch.min != null) url += `&min_val=${encodeURIComponent(stretch.min)}`;
    if (stretch && stretch.max !== "" && stretch.max != null) url += `&max_val=${encodeURIComponent(stretch.max)}`;
    return url;
  };


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


    if (channel === "default") {
      const file = histDropdownFile || selectedFile;
      if (!file) return;
      saveFileStretch(file, "default", minVal, maxVal);
      setSelectedFile(file);
      setViewMode("raster");
      loadImage(buildSingleImageUrl(file, nextStretch.default), rasterViewKey(file));
      setHistSelectedRange({ filename: file, channel: "default", min: minVal, max: maxVal });
      return;
    }
    const isRgbComposite = rFile && gFile && bFile;
    if (isRgbComposite) {
      const channelFile = channel === "r" ? rFile : channel === "g" ? gFile : bFile;
      saveFileStretch(channelFile, channel, minVal, maxVal);
      setSelectedFile(null);
      setViewMode("rgb");
      loadImage(buildCompositeUrl(rFile, gFile, bFile, nextStretch), compositeViewKey(rFile, gFile, bFile));
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
    loadImage(buildSingleImageUrl(fileToUse, nextStretch[channel]), rasterViewKey(fileToUse));
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


    if (rFile && gFile && bFile) {
      setViewMode("rgb");
      setSelectedFile(null);
      loadImage(
        buildCompositeUrl(rFile, gFile, bFile, noStretch),
        compositeViewKey(rFile, gFile, bFile),
        false
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
        true
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
      return;
    }


    const r = remainingFiles[0];
    const g = remainingFiles[1] || remainingFiles[0];
    const b = remainingFiles[2] || g;


    setRFile(r);
    setGFile(g);
    setBFile(b);
    setSelectedFile(null);
    setViewMode("rgb");


    containerRgbRef.current[containerName] = { r, g, b };


    const noStretch = createEmptyStretchValues();
    setStretchValues(noStretch);
    containerStretchRef.current[containerName] = noStretch;


    loadImage(
      buildCompositeUrl(r, g, b, noStretch),
      compositeViewKey(r, g, b),
      false
    );


    axios
      .get(`${API}/metadata`, { params: { filename: r } })
      .then((res) => setRasterInfo(res.data))
      .catch((err) => console.error("Failed to load raster info:", err));


    setTimeout(() => {
      restoreContainerView(containerName);
    }, 0);
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

  // Add files to container IMMEDIATELY (before upload)
  for (const file of filesToUpload) {
    const storedFilePath = `${targetContainerName}/${file.name}`;
    
    setContainers((prev) => {
      const existingFiles = prev[targetContainerName] || [];
      if (existingFiles.includes(storedFilePath)) return prev;
      
      const updatedFiles = [...existingFiles, storedFilePath];
      return { ...prev, [targetContainerName]: updatedFiles };
    });
    
    setFileDisplayNames((prev) => ({ ...prev, [storedFilePath]: file.name }));
  }

  // Upload in background
  for (const file of filesToUpload) {
    const storedFilePath = `${targetContainerName}/${file.name}`;
    
    try {
      const result = await uploadFileChunked(file, targetContainerName, (percent) => {
        setUploadProgress(percent);
      });

      setActiveContainer(targetContainerName);
      setActiveRgbContainer(targetContainerName);

      showToast(`${file.name} stored in ${targetContainerName}`, "success");
    } catch (error) {
      console.error("Upload failed:", error);
      showToast(`Upload failed for ${file.name}: ${error.message}`, "error");
      
      // Remove failed file from container
      setContainers((prev) => {
        const updatedFiles = (prev[targetContainerName] || []).filter(f => f !== storedFilePath);
        return { ...prev, [targetContainerName]: updatedFiles };
      });
      break;
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
    if (rgbBeforeHistRef.current) {
      const prev = rgbBeforeHistRef.current;
      if (prev.r && prev.g && prev.b) {
        setRFile(prev.r);
        setGFile(prev.g);
        setBFile(prev.b);


        const noStretch = createEmptyStretchValues();
        setStretchValues(noStretch);


        if (activeContainer) {
          containerStretchRef.current[activeContainer] = noStretch;
        }


        setViewMode("rgb");
        setSelectedFile(null);
        loadImage(
          buildCompositeUrl(prev.r, prev.g, prev.b, noStretch),
          compositeViewKey(prev.r, prev.g, prev.b),
          false
        );
        rgbBeforeHistRef.current = null;
        return;
      }
      rgbBeforeHistRef.current = null;
    }


    setScale(1);
    if (imgRef.current && containerRef.current) {
      const cw = containerRef.current.clientWidth;
      const ch = containerRef.current.clientHeight;
      const iw = imgRef.current.naturalWidth || 0;
      const ih = imgRef.current.naturalHeight || 0;
      if (iw > 0 && ih > 0) {
        setPosition({ x: (cw - iw) / 2, y: (ch - ih) / 2 });
      } else {
        setPosition({ x: 0, y: 0 });
      }
    } else {
      setPosition({ x: 0, y: 0 });
    }
    userHasSetViewRef.current = true;
  };


  const handleSelectRaster = async (filename) => {
    if (isSwipeMode) return;
    saveCurrentImageHistory();
    const containerName = getContainerForFile(filename) || activeContainer;
    const saved = getSavedImageHistory(containerName, filename);
    setHistoryContext(containerName, filename);


    if (saved) {
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


      const isSavedRgb = saved.rFile && saved.gFile && saved.bFile;
      if (isSavedRgb) {
        setSelectedFile(null);
        setViewMode("rgb");
        loadImage(
          buildCompositeUrl(saved.rFile, saved.gFile, saved.bFile, saved.stretchValues),
          compositeViewKey(saved.rFile, saved.gFile, saved.bFile)
        );
      } else {
        setSelectedFile(filename);
        setViewMode("raster");
        loadImage(
          buildSingleImageUrl(filename, saved.stretchValues?.default || { min: "", max: "" }),
          rasterViewKey(filename)
        );
      }


      if (saved.showHistogram) {
        setHistDefaultData(null);
        fetchHistogramFor(filename, setHistDefaultLoading, setHistDefaultData);
        if (saved.rFile) fetchChannelHistogram(saved.rFile, "r");
        if (saved.gFile) fetchChannelHistogram(saved.gFile, "g");
        if (saved.bFile) fetchChannelHistogram(saved.bFile, "b");
      } else {
        setHistDefaultData(null);
      }


      setTimeout(() => {
        restoreContainerView(containerName);
      }, 0);
    } else {
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


      setTimeout(() => {
        if (containerName) restoreContainerView(containerName);
      }, 0);
    }


    if (containerName) {
      setActiveContainer(containerName);
      setActiveRgbContainer(containerName);
    }


    try {
      const res = await axios.get(`${API}/metadata`, { params: { filename } });
      setRasterInfo(res.data);
    } catch (err) {
      console.error("Failed to load raster info:", err);
    }
  };
  const handleDeleteRaster = async (e, filename) => {
    e.stopPropagation();
    const displayName = getDisplayName(filename);
    if (!window.confirm(`Delete ${displayName}?`)) return;


    const containerName = getContainerForFile(filename) || activeContainer;
    const wasInRGB = rFile === filename || gFile === filename || bFile === filename;
    const wasSelected = selectedFile === filename;


    try {
      await axios.delete(`${API}/files/${encodeURIComponent(filename)}`);
      setContainers((prev) => {
        const updated = {};
        for (const [cName, list] of Object.entries(prev)) {
          const filtered = list.filter((f) => f !== filename);
          if (filtered.length > 0) updated[cName] = filtered;
        }
        return updated;
      });
      setFileDisplayNames((prev) => {
        const updated = { ...prev };
        delete updated[filename];
        return updated;
      });
      delete viewStateRef.current[rasterViewKey(filename)];
      delete stretchStateRef.current[filename];
      for (const key of Object.keys(imageHistoryRef.current)) {
        if (key.endsWith(`:${filename}`)) delete imageHistoryRef.current[key];
      }


      if (swipeLeftFile === filename) setSwipeLeftFile("");
      if (swipeRightFile === filename) setSwipeRightFile("");


      if (wasSelected || (containerName && activeContainer === containerName && wasInRGB)) {
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


  const fetchHistogramFor = async (filename, setLoading, setData) => {
    if (!filename) return;
    setLoading(true);
    try {
      const res = await axios.get(`${API}/histogram`, { params: { filename, band: 1, bins: 32 } });
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


    let nextR = rFile, nextG = gFile, nextB = bFile;
    if (channel === "r") { nextR = value; setRFile(value); }
    if (channel === "g") { nextG = value; setGFile(value); }
    if (channel === "b") { nextB = value; setBFile(value); }


    if (activeContainer) {
      containerRgbRef.current[activeContainer] = { r: nextR, g: nextG, b: nextB };
    }


    const isRgbComposite = nextR && nextG && nextB;
    if (isRgbComposite) {
      setSelectedFile(null);
      setViewMode("rgb");


      const noStretch = createEmptyStretchValues();
      setStretchValues(noStretch);


      if (activeContainer) {
        containerStretchRef.current[activeContainer] = noStretch;
      }


      loadImage(buildCompositeUrl(nextR, nextG, nextB, noStretch), compositeViewKey(nextR, nextG, nextB), true);


      setTimeout(() => {
        if (activeContainer) restoreContainerView(activeContainer);
      }, 0);
    }
  };


  const selectHistChannel = (channel) => {
    saveCurrentImageHistory();
    const file = channel === "r" ? rFile : channel === "g" ? gFile : bFile;
    if (!file) {
      showToast(`Select a file for the ${channel.toUpperCase()} channel first.`, "error");
      return;
    }
    setHistActiveChannel(channel);
    fetchChannelHistogram(file, channel);
    const isRgbComposite = rFile && gFile && bFile;
    if (isRgbComposite) {
      setSelectedFile(null);
      setViewMode("rgb");
      loadImage(buildCompositeUrl(rFile, gFile, bFile, stretchValues), compositeViewKey(rFile, gFile, bFile), true);
    } else {
      setSelectedFile(file);
      setViewMode("raster");
      loadImage(buildSingleImageUrl(file, stretchValues[channel]), rasterViewKey(file), true);
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
      return showToast("No files in active container. Select a container first.", "error");
    }


    let defaultFile = rFile || activeFilesPool[0];
    if (!defaultFile) defaultFile = activeFilesPool[0];


    setProfileFile(defaultFile);
    setSelectedProfileBand(1);


    setShowHistogram(false);
    setShowScatterPlot(false);
    setShowProfileModal(false);
    setIsProfileMode(true);


    showToast("Click start and end points on the image.", "success");
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
    setScale((p) => Math.min(p * 1.25, MAX_SCALE));
    userHasSetViewRef.current = true;
  };
  const handleZoomOut = () => {
    setScale((p) => Math.max(p / 1.25, MIN_SCALE));
    userHasSetViewRef.current = true;
  };
  const handleWheel = (e) => {
    e.preventDefault();
    const z = e.deltaY < 0 ? 1.15 : 0.85;
    setScale((p) => Math.min(Math.max(p * z, MIN_SCALE), MAX_SCALE));
    userHasSetViewRef.current = true;
  };
  const handleMouseDown = (e) => {
    if (e.button !== 0) return;
    if (isProfileMode && imgRef.current) {
      const rect = imgRef.current.getBoundingClientRect();
      const clickX = (e.clientX - rect.left) / scale;
      const clickY = (e.clientY - rect.top) / scale;
      const nw = imgRef.current.naturalWidth || 100;
      const nh = imgRef.current.naturalHeight || 100;
      const fx = (rasterInfo?.width || nw) / nw;
      const fy = (rasterInfo?.height || nh) / nh;
      const rasterX = clickX * fx;
      const rasterY = clickY * fy;
      if (!isDrawingProfile) {
        setProfileStart({ x: rasterX, y: rasterY });
        setProfileEnd(null);
        setIsDrawingProfile(true);
      } else {
        setProfileEnd({ x: rasterX, y: rasterY });
        setIsDrawingProfile(false);
        setIsProfileMode(false);
        fetchProfilePlot(profileStart, { x: rasterX, y: rasterY }, profileFile, selectedProfileBand);
      }
      return;
    }
    setIsDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    userHasSetViewRef.current = true;
  };
  const handleMouseMove = (e) => {
    if (!isDragging) return;
    setPosition({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  };
  const handleMouseUp = () => {
    setIsDragging(false);
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
                      const savedRgb = containerRgbRef.current[containerName];
                      const savedStretch = containerStretchRef.current[containerName];
                      const savedViewState = containerViewStateRef.current[containerName];
                      if (savedViewState) {
                        setScale(savedViewState.scale);
                        setPosition(savedViewState.position);
                      }
                      const stretchToUse = savedStretch || createEmptyStretchValues();
                      setStretchValues(stretchToUse);
                      if (savedRgb && savedRgb.r && savedRgb.g && savedRgb.b) {
                        setRFile(savedRgb.r);
                        setGFile(savedRgb.g);
                        setBFile(savedRgb.b);
                        setViewMode("rgb");
                        setSelectedFile(null);
                        loadImage(
                          buildCompositeUrl(savedRgb.r, savedRgb.g, savedRgb.b, stretchToUse),
                          compositeViewKey(savedRgb.r, savedRgb.g, savedRgb.b),
                          false
                        );
                      } else {
                        autoSelectRGBForContainer(containerName);
                      }
                      setHistActiveChannel(null);
                      setHistDropdownFile("");
                      setShowHistogram(false);
                      setTimeout(() => {
                        restoreContainerView(containerName);
                      }, 0);
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
        gridTemplateColumns: "1fr 26px", // Changed from "42px 1fr 26px"
      }}
    >
      {/* REMOVE THIS IMG TAG */}
      {/* <img src={getThumbnailUrl(filePath)} alt={fileName} style={styles.thumbnail} /> */}
      
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
    <div
      id="osd-viewer"
      ref={osdContainerRef}
      style={{ position: "absolute", inset: 0, background: "#07090c" }}
    />
  )}
          {isImageLoading && !isSwipeMode && (
            <div style={styles.loadingBadge}>
              <div style={styles.spinnerSmall} /><span>Loading tiles…</span>
            </div>
          )}
          {!isSwipeMode && displayedImageUrl && showMinimap && (
            <div title="Navigation overview" onClick={(e) => { if (!imgRef.current || !containerRef.current) return; const miniEl = e.currentTarget.getBoundingClientRect(); const clickX = e.clientX - miniEl.left; const clickY = e.clientY - miniEl.top; const clickPctX = clickX / miniEl.width; const clickPctY = clickY / miniEl.height; const imgRect = imgRef.current.getBoundingClientRect(); const contRect = containerRef.current.getBoundingClientRect(); const clickDispX = clickPctX * imgRect.width; const clickDispY = clickPctY * imgRect.height; const desiredImgLeft = contRect.left + (contRect.width / 2) - clickDispX; const desiredImgTop = contRect.top + (contRect.height / 2) - clickDispY; const deltaX = desiredImgLeft - imgRect.left; const deltaY = desiredImgTop - imgRect.top; setPosition((prev) => ({ x: prev.x + deltaX, y: prev.y + deltaY })); }} style={{ ...styles.minimapContainer, right: (showHistogram || showScatterPlot || showProfileModal) ? "378px" : "18px" }}>
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
            <h3 style={{ margin: 0, fontSize: "14px", color: "#f8fafc" }}>Raster Cross-Section Profile</h3>
            <button style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer" }} onClick={() => setShowProfileModal(false)}>✕</button>
          </div>
          <div style={{ display: "flex", gap: "8px", marginBottom: "16px", alignItems: "center" }}>
            <label style={{ fontSize: "11px", color: "#94a3b8" }}>Layer/Band:</label>
            <select value={profileFile} onChange={(e) => { const f = e.target.value; setProfileFile(f); if (profileStart && profileEnd) fetchProfilePlot(profileStart, profileEnd, f, selectedProfileBand); }} style={{ ...styles.selectInput, flex: 1 }}>
              {activeFilesPool.map((f) => <option key={`pf-${f}`} value={f}>{getDisplayName(f)}</option>)}
            </select>
            {isProfileLoading && <span style={styles.inlineSpinner} />}
          </div>
          {isProfileLoading ? (
            <div style={{ textAlign: "center", padding: "40px", color: "#94a3b8", fontSize: "12px" }}>Calculating profile slice...</div>
          ) : profileData && profileData.values ? (
            <div>
              <div style={{ display: "flex", alignItems: "flex-end", height: "130px", gap: "2px", borderBottom: "1px solid #2a2d34", paddingBottom: "2px", marginBottom: "8px" }}>
                {profileData.values.map((val, idx) => {
                  const min = profileData.min;
                  const max = profileData.max === min ? min + 1 : profileData.max;
                  const pct = Math.max(Math.min(Math.round(((val - min) / (max - min)) * 100), 100), 2);
                  return (
                    <div key={idx} title={`Value: ${val.toFixed(2)}`} style={{ flex: 1, height: "100%", display: "flex", alignItems: "flex-end" }}>
                      <div style={{ width: "100%", height: `${pct}%`, backgroundColor: "#10b981", borderRadius: "1px 1px 0 0" }} />
                    </div>
                  );
                })}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: "#64748b", marginBottom: "16px" }}>
                <span>Start (Distance 0)</span><span>End (Distance Max)</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "6px", fontSize: "11px", color: "#94a3b8", background: "#14171d", padding: "8px", borderRadius: "4px", border: "1px solid #1e222d" }}>
                <div>Min: {profileData.min.toFixed(2)}</div>
                <div>Max: {profileData.max.toFixed(2)}</div>
              </div>
            </div>
          ) : (
            <div style={{ color: "#ef4444", fontSize: "12px" }}>No profile data found</div>
          )}
        </div>
      )}

      {toast && (
        <div style={{ ...styles.toast, ...(toast.type === "success" ? styles.toastSuccess : styles.toastError) }}>
          {toast.message}
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

}

const styles = {
  appContainer: { display: "flex", height: "100vh", width: "100vw", backgroundColor: "#0b0d11", color: "#e2e8f0", fontFamily: "Inter, sans-serif", userSelect: "none", overflow: "hidden" },
  sidebar: { width: "280px", borderRight: "1px solid #1e222d", padding: "16px", display: "flex", flexDirection: "column", backgroundColor: "#0f1219", flexShrink: 0 },
  sidebarHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" },
  sidebarTitle: { margin: 0, fontSize: "18px", fontWeight: "700", color: "#f8fafc" },
  versionBadge: { fontSize: "11px", background: "#1e293b", color: "#94a3b8", padding: "2px 6px", borderRadius: "4px" },
  uploadBtn: { display: "flex", alignItems: "center", justifyContent: "center", background: "#2563eb", color: "#ffffff", padding: "10px", borderRadius: "6px", fontWeight: "600", fontSize: "13px", cursor: "pointer", marginBottom: "20px" },
  uploadProgressContainer: { marginBottom: "16px" },
  progressText: { fontSize: "11px", color: "#94a3b8", marginBottom: "4px" },
  progressBarBg: { background: "#1e293b", height: "4px", borderRadius: "2px", overflow: "hidden" },
  progressBarFill: { background: "#22c55e", height: "100%" },
  sectionHeader: { fontSize: "12px", fontWeight: "600", textTransform: "uppercase", color: "#64748b", marginBottom: "12px", display: "flex", justifyContent: "space-between" },
  badge: { background: "#1e293b", color: "#94a3b8", padding: "1px 6px", borderRadius: "10px", fontSize: "10px" },
  rasterList: { display: "flex", flexDirection: "column", gap: "12px", overflowY: "auto", flex: 1 },
  containerGroup: { display: "flex", flexDirection: "column", gap: "6px", border: "1px solid #1e222d", borderRadius: "6px", padding: "6px", cursor: "pointer", transition: "all 0.15s ease" },
  containerHeaderBar: { fontSize: "11px", fontWeight: "700", color: "#38bdf8", textTransform: "uppercase", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px" },
  emptyStateText: { fontSize: "12px", color: "#475569", textAlign: "center", marginTop: "20px", fontStyle: "italic" },
  rasterCard: { display: "grid", gridTemplateColumns: "42px 1fr 26px", alignItems: "center", gap: "12px", padding: "10px", borderWidth: "1px", borderStyle: "solid", borderRadius: "6px", cursor: "pointer" },
  thumbnail: { width: "42px", height: "42px", objectFit: "cover", borderRadius: "4px", border: "1px solid #2a2d34" },
  rasterInfoText: { overflow: "hidden", minWidth: 0 },
  rasterName: { fontSize: "13px", fontWeight: "600", color: "#f1f5f9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  rasterSubtext: { fontSize: "11px", color: "#64748b", marginTop: "2px" },
  deleteBtn: { background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: "14px" },
  mainContent: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0 },
  toolbar: { minHeight: "68px", backgroundColor: "#0f1219", borderBottom: "1px solid #1e222d", display: "flex", alignItems: "center", padding: "8px 20px", gap: "16px", overflowX: "auto" },
  toolGroup: { display: "flex", flexDirection: "column", gap: "6px", flexShrink: 0, position: "relative" },
  groupLabel: { fontSize: "10px", fontWeight: "600", textTransform: "uppercase", color: "#64748b" },
  btnRow: { display: "flex", alignItems: "center", gap: "10px" },
  iconBtn: { background: "#1e222d", border: "1px solid #2a2d34", color: "#e2e8f0", padding: "6px 12px", borderRadius: "5px", fontSize: "12px", cursor: "pointer", display: "flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap" },
  selectInput: { background: "#14171d", color: "#f8fafc", border: "1px solid #2a2d34", padding: "5px 8px", borderRadius: "5px", fontSize: "12px", outline: "none", cursor: "pointer" },
  selectPair: { display: "flex", alignItems: "center", gap: "4px" },
  stretchBtn: { background: "#1e293b", border: "1px solid #2a2d34", color: "#e2e8f0", padding: "4px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: "600", cursor: "pointer", whiteSpace: "nowrap" },
  stretchInput: { background: "#0b0d11", color: "#f8fafc", border: "1px solid #2a2d34", padding: "5px 8px", borderRadius: "5px", fontSize: "11px", outline: "none", width: "50%" },
  inlineSpinner: { width: "12px", height: "12px", border: "2px solid #38bdf8", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 },
  divider: { width: "1px", height: "36px", backgroundColor: "#1e222d", flexShrink: 0 },
  metaStrip: { height: "32px", backgroundColor: "#0b0d11", borderBottom: "1px solid #1e222d", display: "flex", alignItems: "center", padding: "0 20px", gap: "20px", fontSize: "12px", color: "#94a3b8", flexShrink: 0 },
  viewport: { flex: 1, position: "relative", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#07090c" },
  rasterImageStyle: { position: "absolute", maxWidth: "none", maxHeight: "none", pointerEvents: "none", display: "block" },
  placeholder: { color: "#475569", fontSize: "14px", fontStyle: "italic" },
  loadingBadge: { position: "absolute", bottom: "20px", right: "20px", backgroundColor: "#0f1219", border: "1px solid #1e222d", padding: "8px 16px", borderRadius: "6px", display: "flex", alignItems: "center", gap: "10px", fontSize: "12px", color: "#f8fafc", boxShadow: "0 4px 12px rgba(0,0,0,0.5)", zIndex: 10 },
  spinnerSmall: { width: "14px", height: "14px", border: "2px solid #38bdf8", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" },
  toast: { position: "fixed", bottom: "24px", left: "50%", transform: "translateX(-50%)", padding: "10px 20px", borderRadius: "6px", fontSize: "13px", fontWeight: "500", zIndex: 2000, boxShadow: "0 4px 12px rgba(0,0,0,0.5)" },
  toastSuccess: { backgroundColor: "#065f46", color: "#d1fae5", border: "1px solid #059669" },
  toastError: { backgroundColor: "#991b1b", color: "#fee2e2", border: "1px solid #dc2626" },
  modalBackdrop: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3000 },
  modalBox: { backgroundColor: "#0f1219", border: "1px solid #1e222d", borderRadius: "8px", padding: "24px", width: "360px", boxShadow: "0 8px 24px rgba(0,0,0,0.6)" },
  sidePanel: { position: "fixed", top: 0, right: 0, bottom: 0, width: "360px", backgroundColor: "#0f1219", borderLeft: "1px solid #1e222d", boxShadow: "-8px 0 24px rgba(0,0,0,0.5)", zIndex: 900, overflowY: "auto", padding: "20px" },
  histPanel: { position: "fixed", top: 0, right: 0, bottom: 0, width: "360px", backgroundColor: "#0f1219", borderLeft: "1px solid #1e222d", boxShadow: "-8px 0 24px rgba(0,0,0,0.5)", zIndex: 900, overflowY: "auto", padding: "20px" },
  modalTitle: { margin: "0 0 8px 0", fontSize: "16px", fontWeight: "700", color: "#f8fafc" },
  modalSubtitle: { margin: "0 0 16px 0", fontSize: "12px", color: "#94a3b8" },
  modalContainerList: { display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" },
  modalOptionBtn: { background: "#14171d", border: "1px solid #2a2d34", color: "#e2e8f0", padding: "10px 14px", borderRadius: "6px", fontSize: "13px", fontWeight: "600", textAlign: "left", cursor: "pointer" },
  modalCancelBtn: { background: "transparent", border: "1px solid #2a2d34", color: "#94a3b8", padding: "8px", borderRadius: "6px", fontSize: "12px", width: "100%", cursor: "pointer" },
  minimapContainer: { position: "absolute", right: "18px", bottom: "18px", width: "300px", height: "220px", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "6px", overflow: "hidden", background: "#0b0d11", boxShadow: "0 6px 18px rgba(0,0,0,0.6)", zIndex: 1200, cursor: "pointer" },
  minimapImage: { width: "100%", height: "100%", objectFit: "cover", transform: "scale(1)", display: "block" },
  miniViewportRect: { position: "absolute", border: "2px solid rgba(59,130,246,0.9)", boxSizing: "border-box", pointerEvents: "none", backgroundColor: "rgba(59,130,246,0.08)" },
};