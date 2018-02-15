/*
 * Copyright (c) 2017, Hugo Freire <hugo@exec.sh>.
 *
 * This source code is licensed under the license found in the
 * LICENSE.md file in the root directory of this source tree.
 */

const Promise = require('bluebird')

const Database = require('../../database')

class Message {
  readMessages (messages) {
    return Promise.mapSeries(messages, (message) => {
      return Database.messages.upsert(message, {
        where: {
          channelName: message.channelName,
          channelMessageId: message.channelMessageId
        }
      })
    })
  }
}

module.exports = new Message()
