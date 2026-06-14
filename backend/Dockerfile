# Backend Dockerfile for FastAPI service
FROM python:3.12-slim

WORKDIR /app

# Install runtime dependencies
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend app source and shared agent modules
COPY backend ./backend
COPY Agents ./Agents

# Expose FastAPI default port
EXPOSE 8000

# Run the backend using uvicorn
CMD ["uvicorn", "backend.server:app", "--host", "0.0.0.0", "--port", "8000"]
