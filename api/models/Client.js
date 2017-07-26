'use strict';

const Model = require('trails/model');
const isHTML = require('is-html');
const validate = require('mongoose-validator');

/**
 * @module Client
 * @description OAuth Client
 */
module.exports = class Client extends Model {

  static config () {
  }

  static schema () {
    const isHTMLValidator = function (v) {
      return !isHTML(v);
    };

    return {
      id: {
        type: String,
        trim: true,
        required: [true, 'Client ID is required'],
        unique: true,
        validate: {
          validator: isHTMLValidator,
          message: 'HTML code is not allowed in id'
        }
      },
      name: {
        type: String,
        trim: true,
        required: [true, 'Client name is required'],
        validate: {
          validator: isHTMLValidator,
          message: 'HTML code is not allowed in name'
        }
      },
      secret: {
        type: String,
        trim: true,
        required: [true, 'Client secret is required'],
        validate: {
          validator: isHTMLValidator,
          message: 'HTML code is not allowed in secret'
        }
      },
      url: {
        type: String,
        trim: true,
        validate: validate({
          validator: 'isURL',
          passIfEmpty: true,
          message: 'URL should be a URL'
        })
      },
      // TODO: add validation
      redirectUri: {
        type: String,
        trim: true,
        required: [true, 'Redirect uri is required']
      },
      // TODO: add validation
      loginUri: {
        type: String,
        trim: true
      },
      description: {
        type: String,
        validate: {
          validator: isHTMLValidator,
          message: 'HTML code is not allowed in description'
        }
      }
    };
  }
};
