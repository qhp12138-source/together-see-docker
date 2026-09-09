FROM nginx:1.28.3-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236

COPY ./nginx/default.conf /etc/nginx/conf.d/default.conf
COPY ./index.html ./room.html /usr/share/nginx/html/
COPY ./assets /usr/share/nginx/html/assets
COPY ./LICENSE /usr/share/nginx/html/LICENSE

EXPOSE 80
