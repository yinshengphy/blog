FROM nginx:1.19.0
RUN rm -rf /usr/share/nginx/html/*
COPY public/* /usr/share/nginx/html/
RUN echo "Asia/Shanghai" > /etc/timezone