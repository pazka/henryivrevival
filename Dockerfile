# make a dockerfile for a ts-node application
# use the lightest image possible 

FROM node:14-alpine

# Create app directory

WORKDIR /usr/src/app

# Install app dependencies

COPY package*.json ./

RUN npm install

# Bundle app source

COPY . .

EXPOSE 3000

CMD [ "npm", "start" ]