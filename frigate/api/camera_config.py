"""Locked camera removal from persisted and runtime configuration."""

import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from filelock import FileLock, Timeout
from ruamel.yaml import YAML

from frigate.api.config_util import swap_runtime_config
from frigate.config import FrigateConfig
from frigate.config.camera.updater import (
    CameraConfigUpdateEnum,
    CameraConfigUpdateTopic,
)
from frigate.util.config import find_config_file

logger = logging.getLogger(__name__)


def remove_camera_from_config(app: FastAPI, camera_name: str) -> JSONResponse | None:
    """Remove a camera under the config lock, returning an error if rejected.

    Call from a worker thread. Keep file I/O, validation, runtime updates and
    publication in the same transaction so concurrent writers cannot apply
    an older config after a newer one.
    """
    config_file = find_config_file()
    lock = FileLock(f"{config_file}.lock", timeout=5)

    try:
        with lock:
            frigate_config: FrigateConfig = app.frigate_config

            if camera_name not in frigate_config.cameras:
                return JSONResponse(
                    content={
                        "success": False,
                        "message": f"Camera {camera_name} not found",
                    },
                    status_code=404,
                )

            old_camera_config = frigate_config.cameras[camera_name]

            with open(config_file) as f:
                old_raw_config = f.read()

            try:
                yaml = YAML()
                yaml.indent(mapping=2, sequence=4, offset=2)

                with open(config_file) as f:
                    data = yaml.load(f)

                # Remove camera from config
                if "cameras" in data and camera_name in data["cameras"]:
                    del data["cameras"][camera_name]

                _remove_camera_roles(data, camera_name)

                with open(config_file, "w") as f:
                    yaml.dump(data, f)

                with open(config_file) as f:
                    new_raw_config = f.read()

                try:
                    config = FrigateConfig.parse(new_raw_config)
                except Exception:
                    with open(config_file, "w") as f:
                        f.write(old_raw_config)
                    logger.exception(
                        "Config error after removing camera %s",
                        camera_name,
                    )
                    return JSONResponse(
                        content={
                            "success": False,
                            "message": "Error parsing config after camera removal",
                        },
                        status_code=400,
                    )
            except Exception:
                logger.exception(
                    "Error updating config to remove camera %s", camera_name
                )
                return JSONResponse(
                    content={
                        "success": False,
                        "message": "Error updating config",
                    },
                    status_code=500,
                )

            # rebind every collaborator to the new config and re-layer runtime
            # toggles for the surviving cameras, same as /api/config/set
            swap_runtime_config(app, config)

            # drop the deleted camera's persisted overrides so a camera later
            # added under the same name doesn't inherit them
            if app.dispatcher is not None:
                app.dispatcher.clear_runtime_state_for_camera(camera_name)

            # Publish removal to stop ffmpeg processes and clean up runtime state
            app.config_publisher.publish_update(
                CameraConfigUpdateTopic(CameraConfigUpdateEnum.remove, camera_name),
                old_camera_config,
            )

    except Timeout:
        return JSONResponse(
            content={
                "success": False,
                "message": "Another process is currently updating the config",
            },
            status_code=409,
        )

    return None


def _remove_camera_roles(data: dict, camera_name: str) -> None:
    """Remove camera references and custom roles left without cameras."""
    auth = data.get("auth")
    if not auth:
        return
    roles = auth.get("roles", {})
    for role_name, cameras in list(roles.items()):
        if isinstance(cameras, list) and camera_name in cameras:
            cameras.remove(camera_name)
            if not cameras and role_name not in ("admin", "viewer"):
                del roles[role_name]
