import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const API_BASE =
  window.location.hostname.includes("github.dev")
    ? `${window.location.protocol}//${window.location.hostname.replace("-5173", "-8000")}/api`
    : "http://127.0.0.1:8000/api";

export default function TileMapView({ filename }) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const rasterLayerRef = useRef(null);

  useEffect(() => {
    if (!mapContainerRef.current || !filename) return;

    const map = L.map(mapContainerRef.current, {
      crs: L.CRS.EPSG3857,
      zoomControl: true,
      minZoom: 0,
      maxZoom: 18,
      worldCopyJump: false,
    });

    mapRef.current = map;

    const rasterUrl =
      `${API_BASE}/tile?filename=${encodeURIComponent(filename)}` +
      "&z={z}&x={x}&y={y}";

    const rasterLayer = L.tileLayer(rasterUrl, {
      tileSize: 256,
      minZoom: 0,
      maxZoom: 18,
      tms: false,
      crossOrigin: true,
      updateWhenIdle: true,
      keepBuffer: 2,
      attribution: "Remote Sensing Viewer",
    });

    rasterLayer.addTo(map);
    rasterLayerRef.current = rasterLayer;

    // Start with a world view. The raster tiles will appear when their
    // geographic extent intersects the current map view.
    map.setView([20, 0], 2);

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [filename]);

  return (
    <div
      ref={mapContainerRef}
      style={{
        width: "100%",
        height: "100%",
        minHeight: "400px",
        background: "#07090c",
      }}
    />
  );
}