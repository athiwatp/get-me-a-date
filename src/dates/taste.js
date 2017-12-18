/*
 * Copyright (c) 2017, Hugo Freire <hugo@exec.sh>.
 *
 * This source code is licensed under the license found in the
 * LICENSE.md file in the root directory of this source tree.
 */

const _ = require('lodash')

const AWS_REGION = process.env.AWS_REGION
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY
const AWS_REKOGNITION_COLLECTION = process.env.AWS_REKOGNITION_COLLECTION
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET

const Promise = require('bluebird')

const Logger = require('modern-logger')

const Database = require('../database')

const S3 = require('../utils/s3')
const Rekognition = require('../utils/rekognition')

const Request = require('request-on-steroids')

const sharp = require('sharp')

const { parse } = require('url')

const deleteFaces = function (faces) {
  return this._rekognition.deleteFaces(this._rekognitionCollection, faces)
    .then(() => faces.length)
    .catch((error) => Logger.warn(error.message))
}

const indexFacesFromImages = function (images) {
  let indexedFaces = 0

  return Promise.map(images, (image) => {
    return this._rekognition.indexFaces(this._rekognitionCollection, this._s3Bucket, image)
      .then((data) => {
        if (!data.FaceRecords) {
          return
        }

        // delete images with no or multiple faces
        if (data.FaceRecords.length !== 1) {
          return this._rekognition.deleteFaces(this._rekognitionCollection, _.map(data.FaceRecords, ({ Face }) => Face.FaceId))
            .then(() => {
              return this._s3.deleteObject(this._s3Bucket, image)
            })
        }

        indexedFaces++
      })
      .catch((error) => {
        if (_.some([ 'InvalidImageFormatException', 'InvalidParameterException' ], (message) => _.includes(error.code, message))) {
          return this._s3.deleteObject(this._s3Bucket, image)
        }

        return Logger.warn(error.message)
      })
  }, { concurrency: 2 })
    .then(() => indexedFaces)
}

const checkPhotoOut = function (channelName, photo) {
  if (photo.similarity_date) {
    return photo.similarity // do not s3 and rekognition photos that have already been checked out
  }

  return savePhoto.bind(this)(channelName, photo)
    .then((image) => compareFacesFromImage.bind(this)(photo, image))
    .catch((error) => Logger.warn(error.message))
}

const savePhoto = function (channelName, photo, options = {}) {
  if (!channelName || !photo) {
    return Promise.reject(new Error('invalid arguments'))
  }

  const url = parse(photo.url)
  if (!url) {
    return Promise.reject(new Error('invalid photo url'))
  }

  return this._request.get({ url: url.href })
    .then(({ body, statusCode, statusMessage }) => {
      if (statusCode !== 200) {
        throw new Error(`Unable to download photo ${url.href} because of ${statusCode} ${statusMessage}`)
      }

      if (options.resize) {
        return sharp(body)
          .resize(options.resize.width, options.resize.height)
          .toBuffer()
      }

      return body
    })
    .then((body) => {
      let pathname = url.pathname.substring(1).replace('cache/images/', '').replace(`${this._s3Bucket}/photos/${channelName}/`, '')
      if (options.rename) {
        pathname = _.split(pathname, '/')[ 0 ] + `/${options.rename.prepend}` + _.split(pathname, '/')[ 1 ]
      }

      return this._s3.putObject(this._s3Bucket, `photos/${channelName}/${pathname}`, body)
        .then(() => {
          photo.url = `https://s3-${AWS_REGION}.amazonaws.com/${this._s3Bucket}/photos/${channelName}/${pathname}`

          return body
        })
    })
}

const compareFacesFromImage = function (photo, image) {
  return this._rekognition.searchFacesByImage(this._rekognitionCollection, image)
    .then(({ FaceMatches }) => {
      photo.similarity = _.round(_.max(_.map(FaceMatches, 'Similarity')), 2) || 0
      photo.similarity_date = new Date().toISOString()

      return photo.similarity
    })
    .catch((error) => {
      if (_.some([ 'InvalidImageFormatException', 'InvalidParameterException' ], (message) => _.includes(error.code, message))) {
        photo.similarity = 0
        photo.similarity_date = new Date().toISOString()

        return photo.similarity
      }

      throw error
    })
}

class Taste {
  constructor () {
    this._rekognitionCollection = AWS_REKOGNITION_COLLECTION
    this._s3Bucket = AWS_S3_BUCKET

    this._request = new Request({ request: { encoding: null } })

    this._rekognition = new Rekognition({
      region: AWS_REGION,
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY
    })

    this._s3 = new S3({
      region: AWS_REGION,
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY
    })
  }

  start () {
    return Promise.all([
      this.createRekognitionCollectionIfNeeded(),
      this.createS3BucketIfNeeded()
    ])
      .then(() => this.syncS3BucketAndRekognitionCollection())
  }

  createRekognitionCollectionIfNeeded () {
    return this._rekognition.listCollections()
      .then((collectionIds) => {
        this._rekognitionCollection = this._rekognitionCollection ||
          _.find(collectionIds, (collectionId) => _.startsWith(collectionId, 'get-me-a-date-')) ||
          `get-me-a-date-${_.now()}-${_.random(9)}`

        if (!_.includes(collectionIds, this._rekognitionCollection)) {
          return Logger.debug(`Creating AWS Rekognition collection ${this._rekognitionCollection}`)
            .then(() => this._rekognition.createCollection(this._rekognitionCollection))
        }
      })
  }

  createS3BucketIfNeeded () {
    return this._s3.listBuckets()
      .then((buckets) => {
        this._s3Bucket = this._s3Bucket ||
          _.find(buckets, (bucket) => _.startsWith(bucket, 'get-me-a-date-')) ||
          `get-me-a-date-${_.now()}-${_.random(9)}`

        if (!_.includes(buckets, this._s3Bucket)) {
          return Logger.debug(`Creating AWS S3 bucket ${this._s3Bucket}`)
            .then(() => this._s3.createBucket(this._s3Bucket))
        }
      })
  }

  syncS3BucketAndRekognitionCollection () {
    const start = _.now()

    return Promise.props({
      currentFaces: this._rekognition.listFaces(this._rekognitionCollection),
      availableImages: this._s3.listObjects(this._s3Bucket, 'train')
    })
      .then(({ currentFaces, availableImages }) => {
        const { Faces } = currentFaces
        const currentImages = _(Faces)
          .map(({ ExternalImageId }) => ExternalImageId)
          .uniq()
          .value()

        const imagesToDelete = _.difference(currentImages, availableImages)
        const imagesToIndex = _.difference(availableImages, currentImages)

        // TODO: optimize the code below
        const facesToDelete = []
        _.forEach(imagesToDelete, (externalImageId) => {
          const images = _.filter(Faces, { ExternalImageId: externalImageId })

          _.forEach(images, ({ FaceId }) => {
            facesToDelete.push(FaceId)
          })
        })

        return Promise.props({
          deletedFaces: deleteFaces.bind(this)(facesToDelete),
          indexedFaces: indexFacesFromImages.bind(this)(imagesToIndex)
        })
          .then(({ deletedFaces, indexedFaces }) => {
            const stop = _.now()
            const duration = _.round((stop - start) / 1000)

            return Logger.debug(`Synced reference face collection: ${Faces.length - deletedFaces + indexedFaces} faces available (time = ${duration}s, deleted = ${deletedFaces}, indexed = ${indexedFaces})`)
          })
      })
  }

  mentalSnapshot (channelName, photo) {
    if (!channelName || !photo) {
      return Promise.reject(new Error('invalid arguments'))
    }

    const thumbnail = _.clone(photo)
    const options = {
      resize: { width: 84, height: 84 },
      rename: { prepend: '84x84_' }
    }

    return savePhoto.bind(this)(channelName, thumbnail, options)
      .then(() => thumbnail.url)
  }

  findOrCreateNewSettings () {
    return Database.settings.findById(1)
      .then((settings) => {
        if (!settings) {
          return Database.settings.create({})
        }

        return settings
      })
  }

  checkPhotosOut (channelName, photos) {
    if (!channelName || !photos) {
      return Promise.reject(new Error('invalid arguments'))
    }

    const notCheckedOutPhotos = _.filter(photos, (photo) => !photo.similarity_date)

    return Promise.resolve(photos)
      .map((photo) => checkPhotoOut.bind(this)(channelName, photo), { concurrency: 2 })
      .then((faceSimilarities) => {
        const faceSimilarityMax = _.max(faceSimilarities)
        const faceSimilarityMin = _.min(faceSimilarities)
        const faceSimilarityMean = _.round(_.mean(_.without(faceSimilarities, 0, undefined)), 2) || 0

        return this.findOrCreateNewSettings()
          .then((settings) => {
            const like = !_.isEmpty(faceSimilarities) && faceSimilarityMean > settings.likePhotosThreshold

            return Promise.resolve()
              .then(() => {
                if (!_.isEmpty(notCheckedOutPhotos)) {
                  return Logger.debug(`Compared ${notCheckedOutPhotos.length} photo(s)`)
                }
              })
              .then(() => {
                return {
                  faceSimilarities,
                  faceSimilarityMax,
                  faceSimilarityMin,
                  faceSimilarityMean,
                  like
                }
              })
          })
      })
  }

  acquireTaste (photos) {
    return Promise.map(photos, (photo) => {
      const url = parse(photo.url)
      if (!url) {
        return
      }

      const srcKey = url.pathname
      const dstKey = srcKey.replace(`/${this._s3Bucket}/photos`, 'train')

      return this._s3.copyObject(this._s3Bucket, srcKey, dstKey)
        .then(() => dstKey)
    }, { concurrency: 2 })
      .then((images) => indexFacesFromImages.bind(this)(images))
      .then((indexedFaces) => Logger.debug(`Indexed ${indexedFaces} face(s)`))
  }
}

module.exports = new Taste()
