from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
import numpy as np
import rasterio
from rasterio.enums import Resampling
from io import BytesIO
import os
import tempfile
import shutil
from pathlib import Path
from typing import Optional
import math

app = FastAPI()

# Enable CORS for GitHub Codespaces
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Storage directory
STORAGE_DIR = Path("./storage")
STORAGE_DIR.mkdir(exist_ok=True)

# Upload tracking
upload_chunks = {}

def get_file_path(filename: str) -> Path:
    """Get full path for a filename"""
    return STORAGE_DIR / filename

def validate_file_exists(filename: str) -> Path:
    """Validate file exists and return path"""
    file_path = get_file_path(filename)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {filename}")
    return file_path

@app.get("/api/files")
async def list_files():
    """List all uploaded files with container structure"""
    containers = {}
    for item in STORAGE_DIR.iterdir():
        if item.is_dir():
            containers[item.name] = [f.name for f in item.iterdir() if f.is_file()]
        elif item.suffix.lower() in ['.tif', '.tiff']:
            if "_root" not in containers:
                containers["_root"] = []
            containers["_root"].append(item.name)
    return JSONResponse(content={"containers": containers})

@app.post("/api/upload-chunk")
async def upload_chunk(
    file: UploadFile = File(...),
    upload_id: str = Form(...),
    chunk_index: int = Form(...)
):
    """Upload a file chunk"""
    if upload_id not in upload_chunks:
        upload_chunks[upload_id] = {}
    
    chunk_path = STORAGE_DIR / f"chunk_{upload_id}_{chunk_index}"
    with open(chunk_path, "wb") as f:
        content = await file.read()
        f.write(content)
    
    upload_chunks[upload_id][chunk_index] = chunk_path
    return {"status": "ok", "chunk_index": chunk_index}

@app.post("/api/upload-complete")
async def upload_complete(
    upload_id: str = Form(...),
    filename: str = Form(...),
    total_chunks: int = Form(...),
    container_name: str = Form(...)
):
    """Combine chunks and save final file"""
    if upload_id not in upload_chunks:
        raise HTTPException(status_code=400, detail="Upload ID not found")
    
    chunks = upload_chunks[upload_id]
    if len(chunks) != total_chunks:
        raise HTTPException(
            status_code=400, 
            detail=f"Expected {total_chunks} chunks, got {len(chunks)}"
        )
    
    # Create container directory
    container_dir = STORAGE_DIR / container_name
    container_dir.mkdir(exist_ok=True)
    
    # Combine chunks
    final_path = container_dir / filename
    with open(final_path, "wb") as final_file:
        for i in range(total_chunks):
            chunk_path = chunks[i]
            with open(chunk_path, "rb") as chunk_file:
                final_file.write(chunk_file.read())
            chunk_path.unlink()  # Delete chunk
    
    del upload_chunks[upload_id]
    
    return {
        "status": "ok",
        "file_path": str(final_path),
        "filename": filename,
        "container": container_name
    }

@app.delete("/api/files/{filename:path}")
async def delete_file(filename: str):
    """Delete a file"""
    file_path = validate_file_exists(filename)
    file_path.unlink()
    return {"status": "deleted", "filename": filename}

@app.get("/api/metadata")
async def get_metadata(filename: str = Query(...)):
    """Get raster metadata"""
    file_path = validate_file_exists(filename)
    
    try:
        with rasterio.open(file_path) as src:
            return {
                "filename": filename,
                "width": src.width,
                "height": src.height,
                "bands": src.count,
                "dtype": src.dtypes[0],
                "crs": str(src.crs) if src.crs else None,
                "transform": list(src.transform) if src.transform else None,
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read metadata: {str(e)}")

@app.get("/api/thumbnail")
async def get_thumbnail(filename: str = Query(...)):
    """Generate thumbnail for a raster file"""
    file_path = validate_file_exists(filename)
    
    try:
        with rasterio.open(file_path) as src:
            # Calculate thumbnail size (max 200x200)
            thumb_size = 200
            scale = min(thumb_size / src.width, thumb_size / src.height)
            out_width = int(src.width * scale)
            out_height = int(src.height * scale)
            
            # Read first band
            data = src.read(
                1,
                out_shape=(out_height, out_width),
                resampling=Resampling.bilinear
            )
            
            # Normalize to 0-255
            data = ((data - data.min()) / (data.max() - data.min()) * 255).astype(np.uint8)
            
            # Create RGB image
            img = Image.fromarray(data, mode='L')
            img = img.convert('RGB')
            
            # Save to buffer
            buffer = BytesIO()
            img.save(buffer, format='PNG')
            buffer.seek(0)
            
            return StreamingResponse(
                buffer,
                media_type="image/png",
                headers={"Cache-Control": "public, max-age=3600"}
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate thumbnail: {str(e)}")

@app.get("/api/image")
async def get_image(
    filename: str = Query(...),
    min_val: Optional[float] = Query(None),
    max_val: Optional[float] = Query(None)
):
    """Get rendered image with optional stretch"""
    file_path = validate_file_exists(filename)
    
    try:
        with rasterio.open(file_path) as src:
            # Read first band
            data = src.read(1)
            
            # Apply stretch if provided
            if min_val is not None and max_val is not None:
                min_val = float(min_val)
                max_val = float(max_val)
                data = np.clip(data, min_val, max_val)
                data = ((data - min_val) / (max_val - min_val) * 255).astype(np.uint8)
            else:
                # Auto stretch
                data = ((data - data.min()) / (data.max() - data.min()) * 255).astype(np.uint8)
            
            # Create RGB image
            img = Image.fromarray(data, mode='L')
            img = img.convert('RGB')
            
            # Save to buffer
            buffer = BytesIO()
            img.save(buffer, format='PNG')
            buffer.seek(0)
            
            return StreamingResponse(
                buffer,
                media_type="image/png",
                headers={"Cache-Control": "no-cache"}
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to render image: {str(e)}")

@app.get("/api/rgb-composite")
async def get_rgb_composite(
    r_file: str = Query(...),
    g_file: str = Query(...),
    b_file: str = Query(...),
    r_min: Optional[float] = Query(None),
    r_max: Optional[float] = Query(None),
    g_min: Optional[float] = Query(None),
    g_max: Optional[float] = Query(None),
    b_min: Optional[float] = Query(None),
    b_max: Optional[float] = Query(None)
):
    """Generate RGB composite from three rasters"""
    try:
        r_path = validate_file_exists(r_file)
        g_path = validate_file_exists(g_file)
        b_path = validate_file_exists(b_file)
        
        with rasterio.open(r_path) as r_src, \
             rasterio.open(g_path) as g_src, \
             rasterio.open(b_path) as b_src:
            
            # Read bands
            r_data = r_src.read(1).astype(float)
            g_data = g_src.read(1).astype(float)
            b_data = b_src.read(1).astype(float)
            
            # Apply stretch per channel
            def stretch_channel(data, min_val, max_val):
                if min_val is not None and max_val is not None:
                    data = np.clip(data, min_val, max_val)
                    return ((data - min_val) / (max_val - min_val) * 255).astype(np.uint8)
                else:
                    return ((data - data.min()) / (data.max() - data.min()) * 255).astype(np.uint8)
            
            r_data = stretch_channel(r_data, r_min, r_max)
            g_data = stretch_channel(g_data, g_min, g_max)
            b_data = stretch_channel(b_data, b_min, b_max)
            
            # Stack RGB
            rgb_data = np.stack([r_data, g_data, b_data], axis=-1)
            
            # Create image
            img = Image.fromarray(rgb_data, mode='RGB')
            
            # Save to buffer
            buffer = BytesIO()
            img.save(buffer, format='PNG')
            buffer.seek(0)
            
            return StreamingResponse(
                buffer,
                media_type="image/png",
                headers={"Cache-Control": "no-cache"}
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate RGB composite: {str(e)}")

@app.get("/api/histogram")
async def get_histogram(
    filename: str = Query(...),
    band: int = Query(1),
    bins: int = Query(32)
):
    """Get histogram for a raster band"""
    file_path = validate_file_exists(filename)
    
    try:
        with rasterio.open(file_path) as src:
            data = src.read(band)
            
            # Calculate histogram
            hist, bin_edges = np.histogram(data.flatten(), bins=bins)
            
            return {
                "filename": filename,
                "band": band,
                "bins": bins,
                "counts": hist.tolist(),
                "min": float(data.min()),
                "max": float(data.max()),
                "mean": float(data.mean()),
                "std": float(data.std()),
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to calculate histogram: {str(e)}")

@app.get("/api/scatter-plot")
async def get_scatter_plot(
    filename: str = Query(...),
    x_band: int = Query(1),
    y_file: str = Query(...),
    y_band: int = Query(1)
):
    """Get scatter plot data between two bands/files"""
    try:
        x_path = validate_file_exists(filename)
        y_path = validate_file_exists(y_file)
        
        with rasterio.open(x_path) as x_src, \
             rasterio.open(y_path) as y_src:
            
            # Read data (sample if too large)
            x_data = x_src.read(x_band)
            y_data = y_src.read(y_band)
            
            # Flatten and sample
            max_points = 1000
            x_flat = x_data.flatten()
            y_flat = y_data.flatten()
            
            if len(x_flat) > max_points:
                indices = np.random.choice(len(x_flat), max_points, replace=False)
                x_flat = x_flat[indices]
                y_flat = y_flat[indices]
            
            # Create points
            points = [
                {"x": float(x), "y": float(y)}
                for x, y in zip(x_flat, y_flat)
            ]
            
            return {
                "x_file": filename,
                "y_file": y_file,
                "x_band": x_band,
                "y_band": y_band,
                "points": points,
                "xMin": float(x_data.min()),
                "xMax": float(x_data.max()),
                "yMin": float(y_data.min()),
                "yMax": float(y_data.max()),
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate scatter plot: {str(e)}")

@app.get("/api/profile-plot")
async def get_profile_plot(
    filename: str = Query(...),
    x0: float = Query(...),
    y0: float = Query(...),
    x1: float = Query(...),
    y1: float = Query(...),
    band: int = Query(1)
):
    """Get profile plot along a line"""
    file_path = validate_file_exists(filename)
    
    try:
        with rasterio.open(file_path) as src:
            data = src.read(band)
            
            # Calculate line
            num_points = int(math.sqrt((x1 - x0)**2 + (y1 - y0)**2))
            num_points = max(10, min(num_points, 500))
            
            x_coords = np.linspace(x0, x1, num_points)
            y_coords = np.linspace(y0, y1, num_points)
            
            # Sample values
            values = []
            for x, y in zip(x_coords, y_coords):
                col = int(min(max(x, 0), data.shape[1] - 1))
                row = int(min(max(y, 0), data.shape[0] - 1))
                values.append(float(data[row, col]))
            
            return {
                "filename": filename,
                "band": band,
                "start": {"x": x0, "y": y0},
                "end": {"x": x1, "y": y1},
                "values": values,
                "min": float(min(values)),
                "max": float(max(values)),
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate profile plot: {str(e)}")

@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "storage": str(STORAGE_DIR)}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)