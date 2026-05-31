FROM alpine:latest
RUN apk add --no-cache wrk nodejs
WORKDIR /wrk
COPY run-benchmark.sh .
COPY verify-payload.js .
COPY capture-stats.sh .
COPY stream-profile.js .
COPY fetch-profile.js .
RUN chmod +x run-benchmark.sh capture-stats.sh
