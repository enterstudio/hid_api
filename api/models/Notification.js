'use strict';

const Model = require('trails/model');
const Schema = require('mongoose').Schema;
const path = require('path');
const ejs = require('ejs');


/**
 * @module Notification
 * @description Notification
 */
module.exports = class Notification extends Model {

  static config () {
    return {
      schema: {
        timestamps: true
      },
      onSchema(app, schema) {

        schema.pre('save', function(next) {
          if (!this.text) {
            const that = this;
            let templatePath = 'notifications/' + this.type;
            if (this.user.locale && this.user.locale === 'fr') {
              templatePath += '/fr';
            }
            templatePath += '/html.ejs';
            const template = path.resolve(templatePath);

            ejs.renderFile(template, {
              createdBy: this.createdBy,
              user: this.user,
              params: this.params
            }, {}, function (err, str) {
              if (err) {
                return next(err);
              }
              that.text = str;
              next();
            });
          }
          else {
            next();
          }
        });
      }
    };
  }

  static schema () {
    return {
      createdBy: {
        type: Schema.ObjectId,
        ref: 'User'
      },

      text: {
        type: String
      },

      type: {
        type: String
      },

      user: {
        type: Schema.ObjectId,
        ref: 'User'
      },

      params: {
        type: Schema.Types.Mixed
      },

      read: {
        type: Boolean,
        default: false
      },

      notified: {
        type: Boolean,
        default: false
      }
    };
  }


};
