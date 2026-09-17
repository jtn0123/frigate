/** Match classification train images to dataset classes. */

/**
 * The name a class has in a train image's file name. The backend writes train
 * attempts with every "-" in the class replaced by "_"
 * (`write_classification_attempt`), because the file name is split on "-".
 */
export function trainClassName(name: string): string {
  return name.replaceAll("-", "_");
}

/**
 * Whether a train image's class is one of the selected dataset classes, so a
 * dataset folder named "half-open" matches "half_open" attempts.
 */
export function matchesTrainClass(classes: string[], name: string): boolean {
  const target = trainClassName(name);
  return classes.some((item) => trainClassName(item) === target);
}
