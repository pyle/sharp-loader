// @flow
import sharp from 'sharp';
import loaderUtils from 'loader-utils';
import product from 'cartesian-product';
import findCacheDir from 'find-cache-dir';
import cacache from 'cacache';

import serialize from './internal/serialize';
import createImageObject from './internal/createImageObject';
import transformImage from './internal/transformImage';
import getSyntheticMeta from './internal/getSyntheticMeta';
import getImageMetadata from './internal/getImageMetadata';
import hashOptions from './internal/hashOptions';

import type {Image} from 'sharp';
import type {
  OutputOptions,
  GlobalOptions,
  ImageOptions,
  ImageObject,
} from './types';

const allowedImageProperties = [
  'name',
  'scale',
  'blur',
  'width',
  'height',
  'mode',
  'format',
  'inline',
];

const normalizeProperty = (key, value) => {
  switch (key) {
    case 'scale':
    case 'blur':
    case 'width':
    case 'height':
      return parseFloat(value);
    default:
      return value;
  }
};

const normalizeOutputOptions = (
  options: OutputOptions,
  ...args
): OutputOptions => {
  const normalize = (key, val) => {
    if (typeof val === 'function') {
      return normalize(key, val(...args));
    } else if (Array.isArray(val)) {
      if (val.length === 0) {
        return undefined;
      }
      return val.reduce((out, v) => {
        if (typeof v !== 'undefined') {
          return [...out, normalizeProperty(key, v)];
        }
        return out;
      }, []);
    } else if (typeof val !== 'undefined') {
      return [normalizeProperty(key, val)];
    }
    return undefined;
  };
  const keys = Object.keys(options);
  const result = {};
  keys.forEach((key) => {
    const out = normalize(key, options[key]);
    if (typeof out !== 'undefined') {
      result[key] = out;
    }
  });
  return result;
};

const multiplex = (options) => {
  const keys = Object.keys(options);
  const values = product(
    keys.map((key) => {
      return options[key];
    }),
  );
  return values.map((entries) => {
    const result = {};
    keys.forEach((key, i) => {
      result[key] = entries[i];
    });
    return result;
  });
};

const processImage = (
  input,
  image: Image,
  meta,
  imageOptions: ImageOptions,
  globalOptions: GlobalOptions,
  loader,
): Promise<ImageObject> => {
  if (globalOptions.emitFile === 'synthetic' && imageOptions.inline !== true) {
    return Promise.resolve(
      createImageObject(
        input,
        null,
        getSyntheticMeta(imageOptions, meta),
        imageOptions,
        globalOptions,
        loader,
      ),
    );
  }

  const imageCacheKey = loader.resourcePath + hashOptions(imageOptions);
  const metaCacheKey = `meta${imageCacheKey}`;
  const bufferCacheKey = `buffer${imageCacheKey}`;
  const cachedResult =
    typeof globalOptions.cacheDir === 'string'
      ? Promise.all([
          cacache
            .get(globalOptions.cacheDir, bufferCacheKey)
            .then(({data}) => {
              return data;
            })
            .catch(() => Promise.resolve(null)),
          cacache
            .get(globalOptions.cacheDir, metaCacheKey)
            .then(({data}) => {
              return JSON.parse(data.toString('utf8'));
            })
            .catch(() => Promise.resolve(null)),
        ])
      : Promise.resolve([null, null]);

  const sharpResult = cachedResult.then(([buffer, info]) => {
    if (buffer && info) {
      return {buffer, info};
    }
    const generatedImage = new Promise(function(resolve, reject) {
      const transformedImage = transformImage(image, meta, imageOptions);
      transformedImage.toBuffer(function(err, buffer, info) {
        if (err) {
          reject(err);
        } else {
          resolve({buffer, info});
        }
      });
    });
    return generatedImage.then((result) => {
      if (typeof globalOptions.cacheDir === 'string') {
        return Promise.all([
          cacache.put(globalOptions.cacheDir, bufferCacheKey, result.buffer),
          cacache.put(
            globalOptions.cacheDir,
            metaCacheKey,
            JSON.stringify(result.info),
          ),
        ]).then(() => result);
      }
      return result;
    });
  });

  return sharpResult.then(({buffer, info}) => {
    const result = createImageObject(
      input,
      buffer,
      info,
      imageOptions,
      globalOptions,
      loader,
    );

    if (imageOptions.inline !== true && globalOptions.emitFile !== false) {
      loader.emitFile(result.name, buffer);
    }
    return result;
  });
};

const createImageOptions = (
  meta,
  outputOptions: OutputOptions,
): Array<ImageOptions> => {
  let newMeta = meta;
  if (typeof outputOptions.meta === 'function') {
    newMeta = outputOptions.meta(meta);
  }
  const base = normalizeOutputOptions(outputOptions, newMeta);
  const config = {};
  allowedImageProperties.forEach((key) => {
    if (typeof base[key] !== 'undefined') {
      config[key] = base[key];
    }
  });
  const out = multiplex(config);
  out.forEach((item) => {
    // NOTE: Can copy any non-multiplexed values here.
    if (typeof outputOptions.preset === 'string') {
      item.preset = outputOptions.preset;
    }
  });
  return out;
};

const toArray = (x, defaultValue) => {
  if (x === null || x === undefined) {
    return defaultValue;
  } else if (Array.isArray(x)) {
    return x;
  }
  return [x];
};

/* eslint metalab/import/no-commonjs: 0 */
/* global module */
module.exports = function(input: Buffer) {
  // This means that, for a given query string, the loader will only be
  // run once. No point in barfing out the same image over and over.
  this.cacheable();

  const globalQuery = loaderUtils.getOptions(this);
  const localQuery = this.resourceQuery
    ? loaderUtils.parseQuery(this.resourceQuery)
    : {};

  const image: Image = sharp(input);
  const callback = this.async();
  const context =
    globalQuery.context ||
    this.rootContext ||
    (this.options && this.options.context);

  const cacheDir =
    globalQuery.cacheDirectory === true
      ? findCacheDir({
          name: 'sharp-loader',
        })
      : null;

  const globalOptions = {emitFile: globalQuery.emitFile, context, cacheDir};

  getImageMetadata(image, this.resourcePath, globalOptions)
    .then((meta) => {
      const scaleMatch = /@([0-9]+)x/.exec(this.resourcePath);
      const nextMeta: {
        scale?: number,
      } & typeof meta = {...meta};
      if (scaleMatch) {
        nextMeta.scale = parseInt(scaleMatch[1], 10);
        nextMeta.width /= nextMeta.scale;
        nextMeta.height /= nextMeta.scale;
      }
      const presetNames = Object.keys(globalQuery.presets);
      const defaultOutputs = toArray(globalQuery.defaultOutputs, presetNames);
      const outputs = toArray(localQuery.outputs, defaultOutputs);

      const requirePreset = (name) => {
        if (name in globalQuery.presets) {
          return {
            name: globalQuery.name,
            meta: globalQuery.meta,
            ...globalQuery.presets[name],
            preset: name,
          };
        }
        return null;
      };

      const optionsList: Array<ImageOptions> = outputs.reduce(
        (prev: Array<ImageOptions>, output: string | OutputOptions) => {
          if (typeof output === 'string') {
            const preset = requirePreset(output);
            if (preset) {
              return [...prev, ...createImageOptions(nextMeta, preset)];
            }
            return prev;
          } else if (typeof output === 'object') {
            const preset =
              typeof output.preset === 'string'
                ? requirePreset(output.preset)
                : null;
            return [
              ...prev,
              ...createImageOptions(nextMeta, {
                ...preset,
                ...output,
              }),
            ];
          }
          return prev;
        },
        [],
      );
      const assets = optionsList.map((imageOptions) => {
        return processImage(
          input,
          image,
          nextMeta,
          imageOptions,
          globalOptions,
          this,
        );
      });
      return Promise.all(assets).then(function(assets) {
        return `module.exports = ${serialize(assets)};`;
      });
    })
    .then((result) => {
      callback(null, result);
    }, callback);
};

//     webpack.emitWarning(data)
//    webpack.emitError(data)
// https://github.com/callstack/haul/blob/master/src/loaders/assetLoader.js

// Force buffers since sharp doesn't want strings.
module.exports.raw = true;
