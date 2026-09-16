# Publish reusable runtime dependencies independently of application sources.
variable "CACHE" { default = "" }
variable "DEPENDENCY_AMD64_TAG" { default = "" }
variable "DEPENDENCY_ROCM_TAG" { default = "" }
variable "DEPENDENCY_CACHE_FROM" { default = "" }
variable "WEB_ASSETS_TAG" { default = "" }

target "_cache" {
  cache-from = [for ref in split(",", DEPENDENCY_CACHE_FROM) : "type=registry,ref=${ref}"]
}
target "wget" {
  inherits = ["_cache"]
  dockerfile = "docker/main/Dockerfile"
  target = "wget"
  platforms = ["linux/amd64"]
}
target "deps" {
  inherits = ["_cache"]
  dockerfile = "docker/main/Dockerfile"
  target = "deps"
  platforms = ["linux/amd64"]
}
target "amd64-runtime" {
  inherits = ["_cache"]
  dockerfile = "docker/main/Dockerfile"
  target = "frigate-runtime"
  platforms = ["linux/amd64"]
  contexts = { deps = "target:deps" }
  tags = [DEPENDENCY_AMD64_TAG]
  cache-to = ["type=registry,ref=${CACHE}-deps-amd64,mode=max,compression=zstd,compression-level=3"]
}
target "rocm" {
  inherits = ["_cache"]
  dockerfile = "docker/rocm/Dockerfile"
  target = "rocm-runtime"
  platforms = ["linux/amd64"]
  contexts = { deps = "target:deps", wget = "target:wget" }
  args = { ROCM = "7.2.3", HSA_OVERRIDE = "0", HSA_OVERRIDE_GFX_VERSION = "" }
  tags = [DEPENDENCY_ROCM_TAG]
  cache-to = ["type=registry,ref=${CACHE}-deps-rocm,mode=max,compression=zstd,compression-level=3"]
}
group "dependencies" { targets = ["amd64-runtime", "rocm"] }
target "web" {
  inherits = ["_cache"]
  dockerfile = "docker/main/Dockerfile"
  target = "web-assets"
  platforms = ["linux/amd64"]
  tags = [WEB_ASSETS_TAG]
  cache-to = ["type=registry,ref=${CACHE}-web,mode=max,compression=zstd,compression-level=3"]
}
