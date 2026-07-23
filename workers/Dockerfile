FROM golang:1-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /worker .

FROM alpine:3.20
RUN apk add --no-cache ffmpeg ca-certificates
COPY --from=build /worker /usr/local/bin/worker
ENTRYPOINT ["/usr/local/bin/worker"]
