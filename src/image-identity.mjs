import { digest } from "./store.mjs";
// Docker's classic store exposes the config digest as Id; containerd may expose
// the manifest digest. Ordered content-addressed layers plus execution config
// identify the same runnable image independently of that presentation.
export function imageIdentity(image) {
  const defaults = {
    Hostname: "",
    Domainname: "",
    User: "",
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Image: "",
    Volumes: null,
    WorkingDir: "",
    OnBuild: null,
    Labels: null,
  };
  const config = Object.fromEntries(
    Object.entries(image.Config ?? {}).filter(
      ([key, value]) =>
        !(Object.hasOwn(defaults, key) && value === defaults[key]),
    ),
  );
  if (
    !Array.isArray(image.RootFS?.Layers) ||
    !image.RootFS.Layers.length ||
    !image.RootFS.Layers.every((v) => /^sha256:[a-f0-9]{64}$/.test(v))
  )
    throw Error("Invalid content-addressed image layers");
  return digest({
    os: image.Os,
    arch: image.Architecture,
    variant: image.Variant ?? "",
    layers: image.RootFS.Layers,
    config,
  });
}
export function equivalentImage(images, identity) {
  const candidates = images.filter(
    (image) => imageIdentity(image) === identity,
  );
  if (!candidates.length)
    throw Error("No equivalent pinned runtime on selected daemon");
  return candidates.sort((a, b) => a.Id.localeCompare(b.Id))[0];
}
