FROM eclipse-temurin:25-jre
WORKDIR /data
COPY docker/paper-entrypoint.sh /usr/local/bin/paper-entrypoint
RUN chmod 755 /usr/local/bin/paper-entrypoint
ENTRYPOINT ["/usr/local/bin/paper-entrypoint"]