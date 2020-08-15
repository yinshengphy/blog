FROM nginx:1.19.0
COPY public/* /usr/share/nginx/html/
RUN echo "Asia/Shanghai" > /etc/timezone