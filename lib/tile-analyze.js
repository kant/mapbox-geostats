var tilelive = require('tilelive');
var tiletype = require('tiletype');
var Transform = require('stream').Transform;
var util = require('util');
var Promise = require('pinkie-promise');
var MBTiles = require('mbtiles');
var zlib = require('zlib');
var mapboxVectorTile = require('vector-tile');
var Protobuf = require('pbf');
var _ = require('lodash');
var createLayerStats = require('./create-layer-stats');
var registerFeature = require('./register-feature');
var registerAttribute = require('./register-attribute');
var typeIntegerToString = require('./type-integer-to-string');

var VectorTile = mapboxVectorTile.VectorTile;

function TileAnalyzeStream(layerMap) {
  this.layerMap = layerMap;
  Transform.call(this, { objectMode: true });
}

util.inherits(TileAnalyzeStream, Transform);

TileAnalyzeStream.prototype._transform = function (data, enc, done) {
  // Duck-type the data to see if it's a tile
  if (data.buffer === undefined && tiletype.type(data.buffer) !== 'pbf') {
    return done();
  }
  analyzeTile(this.layerMap, data).then(function () {
    done();
  }, done);
};

function getSource(filePath) {
  return new Promise(function (resolve, reject) {
    new MBTiles(filePath, function (err, source) {
      if (err) return reject(err);
      resolve(source);
    });
  });
}

function analyzeSourceStream(source) {
  var layerMap = {};
  return new Promise(function (resolve, reject) {
    var zxyStream = source.createZXYStream();
    var readStream = tilelive.createReadStream(source, { type: 'list' });
    zxyStream.pipe(readStream)
      .pipe(new TileAnalyzeStream(layerMap))
      // TODO: Ensure this is tested
      .on('error', reject)
      .on('end', function () {
        resolve({ layers: _.values(layerMap) });
      })
      .resume();
  });
}

function analyzeTile(layerMap, tile) {
  return new Promise(function (resolve, reject) {
    zlib.gunzip(tile.buffer, function (err, inflatedBuffer) {
      // TODO: Ensure this is tested
      if (err && err.errno === zlib.Z_DATA_ERROR) {
        inflatedBuffer = tile.buffer;
      } else if (err) {
        return reject(err);
      }
      var vectorTile;
      // TODO: Ensure this is tested
      try {
        vectorTile = new VectorTile(new Protobuf(inflatedBuffer));
      } catch (e) {
        return reject(e);
      }
      _.forOwn(vectorTile.layers, function (data, name) {
        analyzeLayer(layerMap, name, data);
      });
      resolve();
    });
  });
}

function analyzeLayer(layerMap, layerName, layerData) {
  if (layerMap[layerName] === undefined) {
    layerMap[layerName] = createLayerStats(layerName);
  }
  var layerStats = layerMap[layerName];
  for (var i = 0, l = layerData.length; i < l; i++) {
    analyzeFeature(layerStats, layerData.feature(i));
  }
}

function analyzeFeature(layerStats, feature) {
  registerFeature(layerStats, {
    type: typeIntegerToString(feature.type),
  });
  _.forOwn(feature.properties, function (value, name) {
    registerAttribute(layerStats, name, value);
  });
}

module.exports = function (filePath) {
  return getSource(filePath).then(analyzeSourceStream);
};