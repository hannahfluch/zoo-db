FROM mongo:8.0
COPY entrypoint.sh /usr/local/bin/zoo-mongo-entrypoint
RUN chmod +x /usr/local/bin/zoo-mongo-entrypoint
ENTRYPOINT ["zoo-mongo-entrypoint"]
CMD ["mongod", "--replSet", "rs0", "--keyFile", "/data/configdb/zoo-keyfile", "--bind_ip_all"]
