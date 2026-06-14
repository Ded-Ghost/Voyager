# Use an official Node.js runtime as a parent image
FROM node:20-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package manifests first and install dependencies
COPY package.json ./

# If you have a package-lock.json, uncomment the line below
# COPY package-lock.json ./

RUN npm install --production

# Copy application source code
COPY . ./

# Expose application port if needed (adjust if your app listens on a port)
# EXPOSE 3000

# Default command
CMD ["node", "index.js"]
