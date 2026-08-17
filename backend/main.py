from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
import numpy as np
import rasterio
from rasterio.enums import Resampling
from io import BytesIO
from pathlib import Path
from typing import Optional
import math


PREVIEW_MAX_SIZE = 1000
THUMBNAIL_MAX_SIZE = 200
JPEG_QUALITY = 82

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STORAGE_DIR = Path("./storage")
STORAGE_DIR.mkdir(exist_ok=True)

upload_chunks = {}
preview_cache = {}


def clear_preview_cache():
    """Clear previews after a file is uploaded or deleted."""
    preview_cache.clear()


def get_file_path(filename: str) -> Path:
    """Return a safe, resolved file path inside storage."""
    storage_root = STORAGE_DIR.resolve()
    file_path = (STORAGE_DIR / filename).resolve()

    if file_path != storage_root and storage_root not in file_path.parents:
        raise HTTPException(status_code=400, detail="Invalid file path")

    return file_path


def validate_file_exists(filename: str) -> Path:
    file_path = get_file_path(filename)

    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {filename}")

    return file_path


def preview_dimensions(width: int, height: int, max_size: int):
    """Downsample while preserving aspect ratio."""
    scale = min(1.0, max_size / width, max_size / height)
    return max(1, int(width * scale)), max(1, int(height * scale))


def read_preview_band(src, band=1, max_size=PREVIEW_MAX_SIZE):
    """Read a downsampled raster band for viewport display."""
    out_width, out_height = preview_dimensions(src.width, src.height, max_size)

    return src.read(
        band,
        out_shape=(out_height, out_width),
        resampling=Resampling.bilinear,
        masked=True,
    )


def brighten_preview(data, nodata=None, low_percentile=2, high_percentile=98):
    """
    Convert raster values to uint8 with a 2-98 percentile stretch.
    Invalid / NoData pixels remain black.
    """
    original_mask = np.ma.getmaskarray(data)
    arr = np.asarray(np.ma.filled(data, np.nan), dtype=np.float32)

    valid_mask = np.isfinite(arr) & ~original_mask

    if nodata is not None:
        valid_mask &= arr != nodata

    # Exclude zero only from the brightness calculation; preserve it as black.
    nonzero_mask = valid_mask & (arr != 0)
    valid_values = arr[nonzero_mask]

    if valid_values.size == 0:
        valid_values = arr[valid_mask]

    if valid_values.size == 0:
        return np.zeros(arr.shape, dtype=np.uint8)

    low, high = np.percentile(valid_values, [low_percentile, high_percentile])

    if not np.isfinite(low) or not np.isfinite(high) or high <= low:
        low = float(valid_values.min())
        high = float(valid_values.max())

    if not np.isfinite(low) or not np.isfinite(high) or high <= low:
        return np.zeros(arr.shape, dtype=np.uint8)

    output = (arr - low) * 255.0 / (high - low)
    output[~np.isfinite(output)] = 0
    output[~valid_mask] = 0

    if nodata is not None:
        output[arr == nodata] = 0

    return np.clip(output, 0, 255).astype(np.uint8)


def manual_or_auto_stretch(data, nodata=None, min_val=None, max_val=None):
    """Use manual stretch values when valid; otherwise use automatic brightening."""
    if min_val is None or max_val is None or max_val <= min_val:
        return brighten_preview(data, nodata=nodata)

    original_mask = np.ma.getmaskarray(data)
    arr = np.asarray(np.ma.filled(data, np.nan), dtype=np.float32)

    valid_mask = np.isfinite(arr) & ~original_mask

    if nodata is not None:
        valid_mask &= arr != nodata

    output = (np.clip(arr, min_val, max_val) - min_val) * 255.0 / (
        max_val - min_val
    )

    output[~np.isfinite(output)] = 0
    output[~valid_mask] = 0

    return np.clip(output, 0, 255).astype(np.uint8)


def cached_jpeg_response(cache_key, image, cache_seconds=3600):
    """Return a cached compressed JPEG response."""
    if cache_key not in preview_cache:
        buffer = BytesIO()
        image.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        preview_cache[cache_key] = buffer.getvalue()

    return StreamingResponse(
        BytesIO(preview_cache[cache_key]),
        media_type="image/jpeg",
        headers={"Cache-Control": f"public, max-age={cache_seconds}"},
    )


@app.get("/api/files")
def list_files():
    """List GeoTIFFs grouped by container."""
    containers = {}

    for item in STORAGE_DIR.iterdir():
        if item.is_dir():
            files = sorted(
                file.name
                for file in item.iterdir()
                if file.is_file() and file.suffix.lower() in {".tif", ".tiff"}
            )
            containers[item.name] = files

        elif item.is_file() and item.suffix.lower() in {".tif", ".tiff"}:
            containers.setdefault("_root", []).append(item.name)

    return JSONResponse(content={"containers": containers})


@app.post("/api/upload-chunk")
async def upload_chunk(
    file: UploadFile = File(...),
    upload_id: str = Form(...),
    chunk_index: int = Form(...),
):
    """Store one incoming upload chunk."""
    if upload_id not in upload_chunks:
        upload_chunks[upload_id] = {}

    chunk_path = STORAGE_DIR / f"chunk_{upload_id}_{chunk_index}"

    with open(chunk_path, "wb") as output:
        output.write(await file.read())

    upload_chunks[upload_id][chunk_index] = chunk_path

    return {"status": "ok", "chunk_index": chunk_index}


@app.post("/api/upload-complete")
def upload_complete(
    upload_id: str = Form(...),
    filename: str = Form(...),
    total_chunks: int = Form(...),
    container_name: str = Form(...),
):
    """Combine chunks into one GeoTIFF file."""
    if upload_id not in upload_chunks:
        raise HTTPException(status_code=400, detail="Upload ID not found")

    if total_chunks <= 0:
        raise HTTPException(status_code=400, detail="Invalid chunk count")

    chunks = upload_chunks[upload_id]

    if len(chunks) != total_chunks:
        raise HTTPException(
            status_code=400,
            detail=f"Expected {total_chunks} chunks, got {len(chunks)}",
        )

    if any(index not in chunks for index in range(total_chunks)):
        raise HTTPException(status_code=400, detail="Missing upload chunk")

    safe_filename = Path(filename).name
    safe_container_name = Path(container_name).name

    container_dir = STORAGE_DIR / safe_container_name
    container_dir.mkdir(exist_ok=True)

    final_path = container_dir / safe_filename

    try:
        with open(final_path, "wb") as final_file:
            for index in range(total_chunks):
                chunk_path = chunks[index]

                with open(chunk_path, "rb") as chunk_file:
                    while block := chunk_file.read(1024 * 1024):
                        final_file.write(block)

                chunk_path.unlink(missing_ok=True)

    except Exception:
        final_path.unlink(missing_ok=True)
        raise

    finally:
        upload_chunks.pop(upload_id, None)

    clear_preview_cache()

    return {
        "status": "ok",
        "file_path": f"{safe_container_name}/{safe_filename}",
        "filename": safe_filename,
        "container": safe_container_name,
    }


@app.delete("/api/files/{filename:path}")
def delete_file(filename: str):
    """Delete a GeoTIFF and clear generated previews."""
    file_path = validate_file_exists(filename)
    file_path.unlink()
    clear_preview_cache()

    return {"status": "deleted", "filename": filename}


@app.get("/api/metadata")
def get_metadata(filename: str = Query(...)):
    """Return basic GeoTIFF metadata."""
    file_path = validate_file_exists(filename)

    try:
        with rasterio.open(file_path) as src:
            return {
                "filename": filename,
                "width": src.width,
                "height": src.height,
                "bands": src.count,
                "dtype": src.dtypes[0],
                "nodata": src.nodata,
                "crs": str(src.crs) if src.crs else None,
                "transform": list(src.transform) if src.transform else None,
            }

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to read metadata: {str(error)}",
        )


@app.get("/api/thumbnail")
def get_thumbnail(filename: str = Query(...)):
    """Create a small bright thumbnail for the sidebar."""
    file_path = validate_file_exists(filename)
    cache_key = f"thumbnail:{filename}"

    try:
        with rasterio.open(file_path) as src:
            data = read_preview_band(src, max_size=THUMBNAIL_MAX_SIZE)
            display_data = brighten_preview(data, nodata=src.nodata)

            image = Image.fromarray(display_data, mode="L").convert("RGB")
            return cached_jpeg_response(cache_key, image, cache_seconds=86400)

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to generate thumbnail: {str(error)}",
        )


@app.get("/api/image")
def get_image(
    filename: str = Query(...),
    min_val: Optional[float] = Query(None),
    max_val: Optional[float] = Query(None),
):
    """Create a cached bright preview for a single raster."""
    file_path = validate_file_exists(filename)
    cache_key = f"image:{filename}:{min_val}:{max_val}"

    try:
        with rasterio.open(file_path) as src:
            data = read_preview_band(src, max_size=PREVIEW_MAX_SIZE)

            display_data = manual_or_auto_stretch(
                data,
                nodata=src.nodata,
                min_val=min_val,
                max_val=max_val,
            )

            image = Image.fromarray(display_data, mode="L").convert("RGB")
            return cached_jpeg_response(cache_key, image)

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to render image: {str(error)}",
        )


@app.get("/api/rgb-composite")
def get_rgb_composite(
    r_file: str = Query(...),
    g_file: str = Query(...),
    b_file: str = Query(...),
    r_min: Optional[float] = Query(None),
    r_max: Optional[float] = Query(None),
    g_min: Optional[float] = Query(None),
    g_max: Optional[float] = Query(None),
    b_min: Optional[float] = Query(None),
    b_max: Optional[float] = Query(None),
):
    """Create a cached, automatically brightened RGB composite."""
    cache_key = (
        f"rgb:{r_file}:{g_file}:{b_file}:"
        f"{r_min}:{r_max}:{g_min}:{g_max}:{b_min}:{b_max}"
    )

    try:
        r_path = validate_file_exists(r_file)
        g_path = validate_file_exists(g_file)
        b_path = validate_file_exists(b_file)

        with (
            rasterio.open(r_path) as r_src,
            rasterio.open(g_path) as g_src,
            rasterio.open(b_path) as b_src,
        ):
            out_width, out_height = preview_dimensions(
                r_src.width,
                r_src.height,
                PREVIEW_MAX_SIZE,
            )

            r_data = r_src.read(
                1,
                out_shape=(out_height, out_width),
                resampling=Resampling.bilinear,
                masked=True,
            )

            g_data = g_src.read(
                1,
                out_shape=(out_height, out_width),
                resampling=Resampling.bilinear,
                masked=True,
            )

            b_data = b_src.read(
                1,
                out_shape=(out_height, out_width),
                resampling=Resampling.bilinear,
                masked=True,
            )

            red = manual_or_auto_stretch(r_data, r_src.nodata, r_min, r_max)
            green = manual_or_auto_stretch(g_data, g_src.nodata, g_min, g_max)
            blue = manual_or_auto_stretch(b_data, b_src.nodata, b_min, b_max)

            rgb_data = np.dstack((red, green, blue))
            image = Image.fromarray(rgb_data, mode="RGB")

            return cached_jpeg_response(cache_key, image)

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to generate RGB composite: {str(error)}",
        )


@app.get("/api/histogram")
def get_histogram(
    filename: str = Query(...),
    band: int = Query(1),
    bins: int = Query(32),
):
    """Return histogram values and statistics."""
    file_path = validate_file_exists(filename)

    try:
        with rasterio.open(file_path) as src:
            if band < 1 or band > src.count:
                raise HTTPException(status_code=400, detail="Invalid raster band")

            data = src.read(band, masked=True)
            valid = data.compressed()

            if valid.size == 0:
                raise HTTPException(status_code=400, detail="Raster has no valid pixels")

            hist, bin_edges = np.histogram(valid, bins=bins)

            return {
                "filename": filename,
                "band": band,
                "bins": bins,
                "counts": hist.tolist(),
                "min": float(valid.min()),
                "max": float(valid.max()),
                "mean": float(valid.mean()),
                "std": float(valid.std()),
                "binEdges": bin_edges.tolist(),
            }

    except HTTPException:
        raise

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to calculate histogram: {str(error)}",
        )


@app.get("/api/scatter-plot")
def get_scatter_plot(
    filename: str = Query(...),
    x_band: int = Query(1),
    y_file: str = Query(...),
    y_band: int = Query(1),
):
    """Return sampled raster-pixel pairs for the scatter plot."""
    try:
        x_path = validate_file_exists(filename)
        y_path = validate_file_exists(y_file)

        with rasterio.open(x_path) as x_src, rasterio.open(y_path) as y_src:
            if x_band < 1 or x_band > x_src.count:
                raise HTTPException(status_code=400, detail="Invalid X raster band")

            if y_band < 1 or y_band > y_src.count:
                raise HTTPException(status_code=400, detail="Invalid Y raster band")

            out_width, out_height = preview_dimensions(
                x_src.width,
                x_src.height,
                1000,
            )

            x_data = x_src.read(
                x_band,
                out_shape=(out_height, out_width),
                resampling=Resampling.nearest,
                masked=True,
            )

            y_data = y_src.read(
                y_band,
                out_shape=(out_height, out_width),
                resampling=Resampling.nearest,
                masked=True,
            )

            x_values = np.asarray(np.ma.filled(x_data, np.nan)).flatten()
            y_values = np.asarray(np.ma.filled(y_data, np.nan)).flatten()

            valid = np.isfinite(x_values) & np.isfinite(y_values)
            x_values = x_values[valid]
            y_values = y_values[valid]

            if x_values.size == 0:
                raise HTTPException(
                    status_code=400,
                    detail="No matching valid pixels found",
                )

            max_points = 1000

            if x_values.size > max_points:
                selected = np.random.choice(
                    x_values.size,
                    max_points,
                    replace=False,
                )
                x_values = x_values[selected]
                y_values = y_values[selected]

            points = [
                {"x": float(x), "y": float(y)}
                for x, y in zip(x_values, y_values)
            ]

            return {
                "x_file": filename,
                "y_file": y_file,
                "x_band": x_band,
                "y_band": y_band,
                "points": points,
                "xMin": float(x_values.min()),
                "xMax": float(x_values.max()),
                "yMin": float(y_values.min()),
                "yMax": float(y_values.max()),
            }

    except HTTPException:
        raise

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to generate scatter plot: {str(error)}",
        )


@app.get("/api/profile-plot")
def get_profile_plot(
    filename: str = Query(...),
    x0: float = Query(...),
    y0: float = Query(...),
    x1: float = Query(...),
    y1: float = Query(...),
    band: int = Query(1),
):
    """Return raster values sampled along a line."""
    file_path = validate_file_exists(filename)

    try:
        with rasterio.open(file_path) as src:
            if band < 1 or band > src.count:
                raise HTTPException(status_code=400, detail="Invalid raster band")

            distance = math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2)
            num_points = max(10, min(int(distance), 500))

            x_values = np.linspace(x0, x1, num_points)
            y_values = np.linspace(y0, y1, num_points)

            sample_points = []

            for x, y in zip(x_values, y_values):
                col = int(np.clip(x, 0, src.width - 1))
                row = int(np.clip(y, 0, src.height - 1))
                longitude, latitude = src.xy(row, col)
                sample_points.append((longitude, latitude))

            values = [
                float(item[0])
                for item in src.sample(sample_points, indexes=band)
            ]

            return {
                "filename": filename,
                "band": band,
                "start": {"x": x0, "y": y0},
                "end": {"x": x1, "y": y1},
                "values": values,
                "min": float(min(values)),
                "max": float(max(values)),
            }

    except HTTPException:
        raise

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to generate profile plot: {str(error)}",
        )


@app.get("/api/health")
def health_check():
    return {
        "status": "healthy",
        "storage": str(STORAGE_DIR),
        "preview_max_size": PREVIEW_MAX_SIZE,
        "cached_previews": len(preview_cache),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)