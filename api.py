#!/usr/bin/env python3
"""Flask API to extract real images from PDFs."""

from flask import Flask, request, jsonify
from flask_cors import CORS
from pathlib import Path
import base64
import tempfile
import fitz  # PyMuPDF

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

def extract_images_from_pdf(pdf_path: Path) -> dict:
    """Extract all images from PDF pages with their metadata.
    
    Returns dict mapping page_num -> list of image data dicts.
    """
    images_by_page = {}
    with fitz.open(pdf_path) as pdf_doc:
        for page_num, page in enumerate(pdf_doc):
            image_list = page.get_images(full=True)
            if image_list:
                page_images = []
                for img_index, img in enumerate(image_list):
                    try:
                        xref = img[0]
                        pix = fitz.Pixmap(pdf_doc, xref)
                        # Convert to PNG if needed
                        if pix.n - pix.alpha < 4:
                            pix = fitz.Pixmap(fitz.csRGB, pix)
                        img_bytes = pix.tobytes("png")
                        pix = None
                        # Get image rect on page
                        rect_list = page.get_image_rects(img)
                        if rect_list:
                            rect = rect_list[0]
                            # Encode to base64 for JSON
                            img_base64 = base64.b64encode(img_bytes).decode('utf-8')
                            page_images.append({
                                'data': f'data:image/png;base64,{img_base64}',
                                'x': rect.x0,
                                'y': rect.y0,
                                'width': rect.width,
                                'height': rect.height,
                            })
                    except Exception as e:
                        print(f"Error extracting image: {e}")
                if page_images:
                    images_by_page[page_num] = page_images
    return images_by_page

@app.route('/api/extract-images', methods=['POST'])
def extract_images():
    """Extract images from uploaded PDF."""
    if 'pdf' not in request.files:
        return jsonify({'error': 'No PDF file provided'}), 400
    
    file = request.files['pdf']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
    
    try:
        # Save to temp file
        with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
            file.save(tmp.name)
            temp_path = tmp.name
        
        # Extract images
        images_by_page = extract_images_from_pdf(Path(temp_path))
        
        # Clean up
        Path(temp_path).unlink()
        
        return jsonify({
            'success': True,
            'images': images_by_page
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000, debug=False)
