---
name: pdf
description: Read, extract text, merge, split, and manipulate PDF files.
---

# PDF Skill

## Overview

This skill provides guidance for working with PDF files — reading, extracting text, merging, splitting, and other common operations.

## Common Operations

### Reading / Extracting Text
- Use `pdfplumber` (Python) or `pdf-parse` (Node.js) for text extraction
- For scanned PDFs, use OCR (Tesseract) before extraction
- Always handle encoding issues gracefully

### Merging PDFs
```bash
# Using pdfunite (poppler-utils)
pdfunite input1.pdf input2.pdf output.pdf

# Using Python PyPDF2
from PyPDF2 import PdfMerger
merger = PdfMerger()
merger.append("input1.pdf")
merger.append("input2.pdf")
merger.write("output.pdf")
```

### Splitting PDFs
```bash
# Extract pages 1-5
pdftk input.pdf cat 1-5 output pages.pdf
```

### Adding Watermarks
- Use reportlab or PyPDF2 for watermarking
- Support both text and image watermarks

## Best Practices

- Always check if a PDF is scanned (image-based) vs text-based before extraction
- Handle password-protected PDFs with appropriate error messages
- For large PDFs, process page by page to avoid memory issues
- Preserve metadata when merging or splitting
