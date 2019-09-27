FROM node:10.10.0

# env
ENV RUN_MODE=DEPLOY

# add project to the image
ADD ./ /EasyDarwin
RUN mkdir -p /EasyDarwin/data

# set working directory to //EasyDarwin
WORKDIR /EasyDarwin

# install node dependencies
RUN cd /EasyDarwin && npm install && npm install node

# RUN server after docker is up
RUN chmod 777 /EasyDarwin/start.sh
CMD ./start.sh
