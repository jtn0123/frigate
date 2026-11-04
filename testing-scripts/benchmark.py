import datetime
import multiprocessing as mp
from statistics import mean

import numpy as np

from frigate.config import DetectorTypeEnum
from frigate.object_detection.base import (
    ObjectDetectProcess,
    RemoteObjectDetector,
    load_labels,
)
from frigate.util.process import FrigateProcess

my_frame = np.expand_dims(np.full((300, 300, 3), 1, np.uint8), axis=0)
labels = load_labels("/labelmap.txt")


def start(id, num_detections, detection_queue, event):
    object_detector = RemoteObjectDetector(
        str(id), "/labelmap.txt", detection_queue, event
    )
    start = datetime.datetime.now().timestamp()

    frame_times = []
    for _ in range(0, num_detections):
        start_frame = datetime.datetime.now().timestamp()
        object_detector.detect(my_frame)
        frame_times.append(datetime.datetime.now().timestamp() - start_frame)

    duration = datetime.datetime.now().timestamp() - start
    object_detector.cleanup()
    print(f"{id} - Processed for {duration:.2f} seconds.")
    print(f"{id} - FPS: {object_detector.fps.eps():.2f}")
    print(f"{id} - Average frame processing time: {mean(frame_times) * 1000:.2f}ms")


####
# Multiple camera processes
####
camera_processes = []

events = {}
for x in range(0, 10):
    events[str(x)] = mp.Event()
detection_queue = mp.Queue()
edgetpu_process_1 = ObjectDetectProcess(
    detection_queue, events, DetectorTypeEnum.edgetpu, "usb:0"
)
edgetpu_process_2 = ObjectDetectProcess(
    detection_queue, events, DetectorTypeEnum.edgetpu, "usb:1"
)

for x in range(0, 10):
    camera_process = FrigateProcess(
        target=start, args=(x, 300, detection_queue, events[str(x)])
    )
    camera_process.daemon = True
    camera_processes.append(camera_process)

start_time = datetime.datetime.now().timestamp()

for p in camera_processes:
    p.start()

for p in camera_processes:
    p.join()

duration = datetime.datetime.now().timestamp() - start_time
print(f"Total - Processed for {duration:.2f} seconds.")
