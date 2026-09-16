# Layer this on docker/rocm/rocm.hcl so both images share one build graph.
variable "CACHE" { default = "" }
variable "AMD64_TAGS" { default = "" }
variable "ROCM_TAGS" { default = "" }
variable "CACHE_COMPRESSION" { default = "zstd" }

# Keep the two cache manifests separate to avoid concurrent writers. Layers
# shared by the images remain content-addressed and reusable by either target.
target "_fork-cache" {
  cache-from = [
    "type=registry,ref=${CACHE}-amd64",
    "type=registry,ref=${CACHE}-rocm",
    "type=registry,ref=ghcr.io/blakeblackshear/frigate:cache-amd64",
    "type=registry,ref=ghcr.io/blakeblackshear/frigate:cache-rocm",
  ]
}
target "wget" { inherits = ["_fork-cache"] }
target "deps" { inherits = ["_fork-cache"] }
target "rootfs" { inherits = ["_fork-cache"] }
target "amd64" {
  inherits = ["_fork-cache"]
  dockerfile = "docker/main/Dockerfile"
  target = "frigate"
  platforms = ["linux/amd64"]
  tags = split(",", AMD64_TAGS)
  cache-to = ["type=registry,ref=${CACHE}-amd64,mode=max,compression=${CACHE_COMPRESSION},compression-level=3"]
}
target "rocm" {
  inherits = ["_fork-cache"]
  tags = split(",", ROCM_TAGS)
  cache-to = ["type=registry,ref=${CACHE}-rocm,mode=max,compression=${CACHE_COMPRESSION},compression-level=3"]
}
group "fork" { targets = ["amd64", "rocm"] }
