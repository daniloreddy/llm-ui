FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
COPY static/ ./static/
COPY scripts/ ./scripts/

# Generate static/tw.css at build time (Tailwind binary downloaded via Python stdlib)
RUN python3 scripts/gen-tw.py

RUN mkdir -p data

EXPOSE 8050

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8050"]
