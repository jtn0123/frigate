# This graph has no driver/package-install targets. Inputs are published images.
variable "CACHE" { default = "" }
variable "AMD64_TAGS" { default = "" }
variable "ROCM_TAGS" { default = "" }
variable "DEPENDENCY_AMD64_IMAGE" { default = "" }
variable "DEPENDENCY_ROCM_IMAGE" { default = "" }
variable "RUNTIME_CACHE_FROM" { default = "" }
variable "WEB_ASSETS_IMAGE" { default = "" }

target "_cache" {
  cache-from = [for ref in split(",", RUNTIME_CACHE_FROM) : "type=registry,ref=${ref}"]
}
target "rootfs" {
  inherits = ["_cache"]
  dockerfile = "docker/fork-rootfs.Dockerfile"
  target = "rootfs"
  platforms = ["linux/amd64"]
  contexts = { web-build = "docker-image://${WEB_ASSETS_IMAGE}" }
}
target "amd64" {
  inherits = ["_cache"]
  dockerfile = "docker/fork-runtime.Dockerfile"
  target = "image"
  platforms = ["linux/amd64"]
  contexts = { runtime = "docker-image://${DEPENDENCY_AMD64_IMAGE}", rootfs = "target:rootfs" }
  tags = split(",", AMD64_TAGS)
  cache-to = ["type=registry,ref=${CACHE}-app-amd64,mode=max,compression=zstd,compression-level=3"]
}
target "rocm" {
  inherits = ["_cache"]
  dockerfile = "docker/fork-runtime.Dockerfile"
  target = "image"
  platforms = ["linux/amd64"]
  contexts = { runtime = "docker-image://${DEPENDENCY_ROCM_IMAGE}", rootfs = "target:rootfs" }
  args = { ROCM = "7.2.3", HSA_OVERRIDE = "0", HSA_OVERRIDE_GFX_VERSION = "" }
  tags = split(",", ROCM_TAGS)
  cache-to = ["type=registry,ref=${CACHE}-app-rocm,mode=max,compression=zstd,compression-level=3"]
}
group "fork" { targets = ["amd64", "rocm"] }
