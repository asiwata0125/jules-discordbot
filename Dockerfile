# Use official Node.js image
FROM node:20-slim

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Bundle app source
COPY . .

# Expose port (Cloud Run sets PORT env var, defaults to 8080)
EXPOSE 8080

# Start command
CMD [ "node", "server.js" ]
