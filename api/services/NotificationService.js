'use strict';

const Service = require('trails-service');
const Boom = require('boom');
const _ = require('lodash');
const async = require('async');

/**
 * @module NotificationService
 * @description Service for notifications
 */
module.exports = class NotificationService extends Service {

  send (notification, callback) {
    const Notification = this.app.orm.Notification;
    var that = this;

    this.log.debug('Sending a notification of type ' + notification.type + ' to user ' + notification.user.email);

    Notification.create(notification, function (err, not) {
      if (err) {
        that.log.error('Error creating a notification: ' + err);
        return callback(Boom.badImplementation());
      }
      that.app.services.EmailService.sendNotification(notification, function (err, info) {
        if (err) {
          that.log.error('Error sending an email notification: ' + err);
          return callback(Boom.badImplementation());
        }
        return callback();
      });
    });
  }

  sendMultiple(users, notification, callback) {
    const User = this.app.orm.User;
    this.log.debug('Sending a notification to multiple users: ' + users);
    var areUsers = true;
    for (var i = 0, len = users.length; i < len; i++) {
      if (users[i].constructor.name === 'ObjectID') {
        areUsers = false;
      }
    }
    if (!areUsers) {
      var that = this;
      this.log.debug('Transforming user ID in users');
      User
        .find({_id: { $in: users}})
        .then((items) => {
          that._sendMultipleHelper(items, notification, callback);
        });
    }
    else {
      this._sendMultipleHelper(users, notification, callback);
    }
  }

  _sendMultipleHelper(users, notification, callback) {
    var that = this;
    async.each(users, function (user, next) {
      notification.user = user;
      that.send(notification, next);
    }, callback);
  }

};
