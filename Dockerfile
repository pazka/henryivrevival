# make a dockerfile for a ts-node application
# use the lightest image possible 

FROM node:20-alpine

# Upgrade bundled npm (npm 10 ships tar <7.5.19, flagged by CVE-2026-59873)

RUN npm install -g npm@11

# Create app directory

WORKDIR /usr/src/app

# Install app dependencies

COPY package*.json ./

RUN npm install

# Bundle app source

COPY . .

EXPOSE 3000

CMD [ "npm", "start" ]