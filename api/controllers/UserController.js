'use strict';

const Controller = require('trails/controller');
const Boom = require('boom');
const qs = require('qs');
const ejs = require('ejs');
const http = require('http');
const moment = require('moment');
const acceptLanguage = require('accept-language');
const sharp = require('sharp');
const validator = require('validator');
const hidAccount = '5b2128e754a0d6046d6c69f2';

/**
 * @module UserController
 * @description Generated Trails.js Controller.
 */
module.exports = class UserController extends Controller{

  _removeForbiddenAttributes (request) {
    const childAttributes = this.app.orm.User.listAttributes();
    this.app.services.HelperService.removeForbiddenAttributes('User', request, childAttributes);
  }

  _errorHandler (err, request, reply) {
    return this.app.services.ErrorService.handle(err, request, reply);
  }

  _createHelper(request, reply) {
    const Model = this.app.orm.User;
    const UserModel = this.app.models.User;

    this.log.debug('Preparing request for user creation', { request: request });

    if (request.payload.email) {
      request.payload.emails = [];
      request.payload.emails.push({type: 'Work', email: request.payload.email, validated: false});
    }

    if (request.payload.password && request.payload.confirm_password) {
      if (!UserModel.isStrongPassword(request.payload.password)) {
        return reply(Boom.badRequest('The password is not strong enough'));
      }
      request.payload.password = UserModel.hashPassword(request.payload.password);
    }
    else {
      // Set a random password
      request.payload.password = UserModel.hashPassword(UserModel.generateRandomPassword());
    }

    const appVerifyUrl = request.payload.app_verify_url;
    delete request.payload.app_verify_url;

    let notify = true;
    if (typeof request.payload.notify !== 'undefined') {
      notify = request.payload.notify;
    }
    delete request.payload.notify;

    let registrationType = '';
    if (request.payload.registration_type) {
      registrationType = request.payload.registration_type;
      delete request.payload.registration_type;
    }

    this._removeForbiddenAttributes(request);

    if (request.params.currentUser && registrationType === '') {
      // Creating an orphan user
      request.payload.createdBy = request.params.currentUser._id;
      // If an orphan is being created, do not expire
      request.payload.expires = new Date(0, 0, 1, 0, 0, 0);
      if (request.payload.email) {
        request.payload.is_orphan = true;
      }
      else {
        request.payload.is_ghost = true;
      }
    }

    // HID-1582: creating a short lived user for testing
    if (request.payload.tester) {
      const now = Date.now();
      request.payload.expires = new Date(now + 3600 * 1000);
      request.payload.email_verified = true;
      delete request.payload.tester;
    }

    const that = this;
    let guser = {};
    Model
      .create(request.payload)
      .then((user) => {
        if (!user) {
          throw Boom.badRequest();
        }
        guser = user;
        that.log.debug('User ' + user._id.toString() + ' successfully created', { request: request });

        if (user.email && notify === true) {
          if (!request.params.currentUser) {
            return that.app.services.EmailService.sendRegister(user, appVerifyUrl);
          }
          else {
            // An admin is creating an orphan user or Kiosk registration
            if (registrationType === 'kiosk') {
              return that.app.services.EmailService.sendRegisterKiosk(user, appVerifyUrl);
            }
            else {
              return that.app.services.EmailService.sendRegisterOrphan(user, request.params.currentUser, appVerifyUrl);
            }
          }
        }
      })
      .then(info => {
        return reply(guser);
      })
      .catch(err => {
        that.app.services.ErrorService.handle(err, request, reply);
      });
  }

  create (request, reply) {
    const options = this.app.packs.hapi.getOptionsFromQuery(request.query);
    const Model = this.app.orm.user;

    this.log.debug('[UserController] (create) payload =', request.payload, 'options =', options, { request: request });

    if (!request.payload.app_verify_url) {
      return reply(Boom.badRequest('Missing app_verify_url'));
    }

    const appVerifyUrl = request.payload.app_verify_url;
    if (!this.app.services.HelperService.isAuthorizedUrl(appVerifyUrl)) {
      this.log.warn('Invalid app_verify_url', { security: true, fail: true, request: request});
      return reply(Boom.badRequest('Invalid app_verify_url'));
    }

    const that = this;
    if (request.payload.email) {
      Model
        .findOne({'emails.email': request.payload.email})
        .then((record) => {
          if (!record) {
            // Create user
            that._createHelper(request, reply);
          }
          else {
            if (!request.params.currentUser) {
              return reply(Boom.badRequest('This email address is already registered. If you can not remember your password, please reset it'));
            }
            else {
              return reply(Boom.badRequest('This user already exists. user_id=' + record._id.toString()));
            }
          }
        })
        .catch(err => {
          that.app.services.ErrorService.handle(err, request, reply);
        });
    }
    else {
      // Create ghost user
      that._createHelper(request, reply);
    }
  }

  _pdfExport (data, req, format, callback) {
    const filters = [];
    if (Object.prototype.hasOwnProperty.call(req.query, 'name') && req.query.name.length) {
      filters.push(req.query.name);
    }
    if (Object.prototype.hasOwnProperty.call(req.query, 'verified') && req.query.verified) {
      filters.push('Verified User');
    }
    if (Object.prototype.hasOwnProperty.call(req.query, 'is_admin') && req.query.is_admin) {
      filters.push('Administrator');
    }
    data.lists.forEach(function (list, index) {
      if (index > 0) {
        filters.push(list.name);
      }
    });

    data.dateGenerated = moment().format('LL');
    data.filters = filters;
    let template = 'templates/pdf/printList.html';
    if (format === 'meeting-compact') {
      template = 'templates/pdf/printMeetingCompact.html';
    }
    else if (format === 'meeting-comfortable') {
      template = 'templates/pdf/printMeetingComfortable.html';
    }
    ejs.renderFile(template, data, {}, function (err, str) {
      if (err) {
        callback(err);
      }
      else {
        const postData = qs.stringify({
            'html': str
          }),
          options = {
            hostname: process.env.WKHTMLTOPDF_HOST,
            port: process.env.WKHTMLTOPDF_PORT || 80,
            path: '/htmltopdf',
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': postData.length
            }
          };

        // Send the HTML to the wkhtmltopdf service to generate a PDF, and
        // return the output.
        const clientReq = http.request(options, function(clientRes) {
          if (clientRes && clientRes.statusCode === 200) {
            clientRes.setEncoding('binary');

            const pdfSize = parseInt(clientRes.headers['content-length']),
              pdfBuffer = new Buffer(pdfSize);
            let bytes = 0;

            clientRes.on('data', function(chunk) {
              pdfBuffer.write(chunk, bytes, 'binary');
              bytes += chunk.length;
            });

            clientRes.on('end', function() {
              callback(null, pdfBuffer, bytes);
            });
          }
          else {
            callback(new Error('An error occurred while generating PDF for list ' + data.lists[0].name));
          }
        });

        // Handle errors with the HTTP request.
        clientReq.on('error', function(e) {
          callback(new Error('An error occurred while generating PDF for list ' + data.lists[0].name));
        });

        // Write post data containing the rendered HTML.
        clientReq.write(postData);
        clientReq.end();
      }
    });
  }

  _txtExport (users) {
    let out = '';
    for (let i = 0; i < users.length; i++) {
      out += users[i].name + ' <' + users[i].email + '>;';
    }
    return out;
  }

  _csvExport (users, full = false) {
    let out = 'Given Name,Family Name,Job Title,Organization,Groups,Roles,Country,Admin Area,Phone,Skype,Email,Notes\n',
      org = '',
      bundles = '',
      roles = '',
      country = '',
      region = '',
      jobTitle = '',
      phoneNumber = '',
      skype = '',
      status = '',
      orphan = '',
      ghost = '',
      verified = '',
      manager = '',
      admin = '';
    if (full) {
      out = 'Given Name,Family Name,Job Title,Organization,Groups,Roles,Country,Admin Area,Phone,Skype,Email,Notes,Created At,Updated At,Orphan,Ghost,Verified,Manager,Admin\n';
    }
    for (let i = 0; i < users.length; i++) {
      org = '';
      bundles = '';
      country = '';
      region = '';
      skype = '';
      roles = '';
      jobTitle = users[i].job_title || ' ';
      phoneNumber = users[i].phone_number || ' ';
      status = users[i].status || ' ';
      if (users[i].organization && users[i].organization.list) {
        org = users[i].organization.name;
      }
      if (users[i].bundles && users[i].bundles.length) {
        users[i].bundles.forEach(function (bundle) {
          bundles += bundle.name + ';';
        });
      }
      if (users[i].functional_roles && users[i].functional_roles.length) {
        users[i].functional_roles.forEach(function (role) {
          roles += role.name + ';';
        });
      }
      if (users[i].location && users[i].location.country) {
        country = users[i].location.country.name;
      }
      if (users[i].location && users[i].location.region) {
        region = users[i].location.region.name;
      }
      if (users[i].voips.length) {
        for (let j = 0; j < users[i].voips.length; j++) {
          if (users[i].voips[j].type === 'Skype') {
            skype = users[i].voips[j].username;
          }
        }
      }
      orphan = users[i].is_orphan ? '1' : '0';
      ghost = users[i].is_ghost ? '1' : '0';
      verified = users[i].verified ? '1' : '0';
      manager = users[i].isManager ? '1' : '0';
      admin = users[i].is_admin ? '1' : '0';
      out = out +
        '"' + users[i].given_name + '",' +
        '"' + users[i].family_name + '",' +
        '"' + jobTitle + '",' +
        '"' + org + '",' +
        '"' + bundles + '",' +
        '"' + roles + '",' +
        '"' + country + '",' +
        '"' + region + '",' +
        '"' + phoneNumber + '",' +
        '"' + skype + '",' +
        '"' + users[i].email + '",' +
        '"' + status;
      if (full) {
        out = out + '",' +
          '"' + users[i].createdAt + '",' +
          '"' + users[i].updatedAt + '",' +
          '"' + orphan + '",' +
          '"' + ghost + '",' +
          '"' + verified + '",' +
          '"' + manager + '",' +
          '"' + admin + '"\n';
      }
      else {
        out = out + '"\n';
      }
    }
    return out;
  }

  _findHelper(request, reply, criteria, options, lists) {
    const User = this.app.orm.User;
    const UserModel = this.app.models.User;
    const reqLanguage = acceptLanguage.get(request.headers['accept-language']);
    let pdfFormat = '';
    if (criteria.format) {
      pdfFormat = criteria.format;
      delete criteria.format;
    }

    const that = this;
    this.log.debug('[UserController] (find) criteria = ', criteria, ' options = ', options, { request: request });
    const query = this.app.services.HelperService.find('User', criteria, options);
    // HID-1561 - Set export limit to 2000
    if (!options.limit && request.params.extension) {
      query.limit(100000);
    }
    if (request.params.extension) {
      query.select('name given_name family_name email job_title phone_number status organization bundles location voips connections phonesVisibility emailsVisibility locationsVisibility createdAt updatedAt is_orphan is_ghost verified isManager is_admin functional_roles');
      query.lean();
    }
    query
      .then((results) => {
        return User
          .count(criteria)
          .then((number) => {
            return {results: results, number: number};
          });
      })
      .then((results) => {
        if (!results.results) {
          return reply(Boom.notFound());
        }
        if (!request.params.extension) {
          for (let i = 0, len = results.results.length; i < len; i++) {
            results.results[i].sanitize(request.params.currentUser);
            results.results[i].translateListNames(reqLanguage);
          }
          return reply(results.results).header('X-Total-Count', results.number);
        }
        else {
          // Sanitize users and translate list names from a plain object
          for (let i = 0, len = results.results.length; i < len; i++) {
            UserModel.sanitizeExportedUser(results.results[i], request.params.currentUser);
            if (results.results[i].organization) {
              UserModel.translateCheckin(results.results[i].organization, reqLanguage);
            }
          }
          if (request.params.extension === 'csv') {
            let csvExport = '';
            if (request.params.currentUser.is_admin) {
              csvExport = that._csvExport(results.results, true);
            }
            else {
              csvExport = that._csvExport(results.results, false);
            }
            return reply(csvExport)
              .type('text/csv')
              .header('Content-Disposition', 'attachment; filename="Humanitarian ID Contacts ' + moment().format('YYYYMMDD') + '.csv"');
          }
          else if (request.params.extension === 'txt') {
            return reply(that._txtExport(results.results))
              .type('text/plain');
          }
          else if (request.params.extension === 'pdf') {
            results.lists = lists;
            that._pdfExport(results, request, pdfFormat, function (err, buffer, bytes) {
              if (err) {
                throw err;
              }
              else {
                reply(buffer)
                  .type('application/pdf')
                  .bytes(bytes)
                  .header('Content-Disposition', 'attachment; filename="Humanitarian ID Contacts ' + moment().format('YYYYMMDD') + '.pdf"');
              }
            });
          }
        }
      })
      .catch((err) => {
        that._errorHandler(err, request, reply);
      });
  }

  find (request, reply) {
    const reqLanguage = acceptLanguage.get(request.headers['accept-language']);
    const User = this.app.orm.User;
    const that = this;

    if (request.params.id) {
      const criteria = {_id: request.params.id};
      if (!request.params.currentUser.verified) {
        criteria.is_orphan = false;
        criteria.is_ghost = false;
      }
      User
        .findOne(criteria)
        .then((user) => {
          if (!user) {
            throw Boom.notFound();
          }
          else {
            user.sanitize(request.params.currentUser);
            user.translateListNames(reqLanguage);
            return reply(user);
          }
        })
        .catch((err) => {
          that._errorHandler(err, request, reply);
        });
    }
    else {
      const options = this.app.services.HelperService.getOptionsFromQuery(request.query);
      const criteria = this.app.services.HelperService.getCriteriaFromQuery(request.query);
      const List = this.app.orm.List;
      const childAttributes = User.listAttributes();

      // Hide unconfirmed users which are not orphans
      if (request.params.currentUser && !request.params.currentUser.is_admin && !request.params.currentUser.isManager) {
        criteria.$or = [{'email_verified': true}, {'is_orphan': true}, {'is_ghost': true}];
      }

      if (criteria.q) {
        if (validator.isEmail(criteria.q) && request.params.currentUser.verified) {
          criteria['emails.email'] = new RegExp(criteria.q, 'i');
        }
        else {
          criteria.name = criteria.q;
        }
        delete criteria.q;
      }

      if (criteria.name) {
        if (criteria.name.length < 3) {
          return reply(Boom.badRequest('Name must have at least 3 characters'));
        }
        criteria.name = criteria.name.replace(/([^a-z0-9 ]+)/gi, '-');
        criteria.name = new RegExp(criteria.name, 'i');
      }

      if (criteria.country) {
        criteria['location.country.id'] = criteria.country;
        delete criteria.country;
      }

      if (!request.params.currentUser.verified) {
        criteria.is_orphan = false;
        criteria.is_ghost = false;
      }
      const listIds = [];
      for (let i = 0; i < childAttributes.length; i++) {
        if (criteria[childAttributes[i] + '.list']) {
          listIds.push(criteria[childAttributes[i] + '.list']);
          delete criteria[childAttributes[i] + '.list'];
        }
      }
      if (!listIds.length) {
        this._findHelper(request, reply, criteria, options, listIds);
      }
      else {
        List
          .find({_id: { $in: listIds}})
          .then((lists) => {
            lists.forEach(function (list) {
              if (list.isVisibleTo(request.params.currentUser)) {
                criteria[list.type + 's'] = {$elemMatch: {list: list._id, deleted: false}};
                if (!list.isOwner(request.params.currentUser)) {
                  criteria[list.type + 's'].$elemMatch.pending = false;
                }
              }
              else {
                throw Boom.unauthorized('You are not authorized to view this list');
              }
            });
            return lists;
          })
          .then((lists) => {
            that._findHelper(request, reply, criteria, options, lists);
          })
          .catch(err => {
            that._errorHandler(err, request, reply);
          });
      }
    }
  }

  _updateQuery (request, options) {
    const User = this.app.orm.user,
      NotificationService = this.app.services.NotificationService,
      EmailService = this.app.services.EmailService,
      that = this;
    let nextAction = '';
    if (request.payload.updatedAt) {
      delete request.payload.updatedAt;
    }
    return User
      .findOneAndUpdate({ _id: request.params.id }, request.payload, {runValidators: true, new: true})
      .exec()
      .then((user) => {
        return user.defaultPopulate();
      })
      .then(user => {
        if (request.params.currentUser._id.toString() !== user._id.toString()) {
          // User is being edited by someone else
          // If it's an auth account, surface it
          if (user.authOnly) {
            nextAction = 'sendAuthToProfile';
            user.authOnly = false;
            return user.save();
          }
          else {
            nextAction = 'notification';
          }
        }
        return user;
      })
      .then(user => {
        if (nextAction === 'sendAuthToProfile') {
          EmailService.sendAuthToProfile(user, request.params.currentUser, () => {});
        }
        if (nextAction === 'notification') {
          const notification = {type: 'admin_edit', user: user, createdBy: request.params.currentUser};
          NotificationService.send(notification, () => {});
        }
        return user;
      })
      .then(user => {
        return that.app.services.GSSSyncService.synchronizeUser(user);
      })
      .then(user => {
        return that.app.services.OutlookService.synchronizeUser(user);
      });
  }

  update (request, reply) {
    const options = this.app.services.HelperService.getOptionsFromQuery(request.query);
    const Model = this.app.orm.user;
    const UserModel = this.app.models.User;

    this.log.debug('[UserController] (update) model = user, criteria =', request.query, request.params.id,
      ', values = ', request.payload, { request: request });

    this._removeForbiddenAttributes(request);
    if (request.payload.password) {
      delete request.payload.password;
    }

    // Make sure user is verified if he is an admin or a manager
    if (request.payload.is_admin || request.payload.isManager) {
      request.payload.verified = true;
    }

    const that = this;
    if ((request.payload.old_password && request.payload.new_password) || request.payload.verified) {
      this.log.debug('Updating user password or user is verified', { request: request });
      // Check old password
      Model
        .findOne({_id: request.params.id})
        .then((user) => {
          if (!user) {
            throw Boom.notFound();
          }
          // If verifying user, set verified_by
          if (request.payload.verified && !user.verified) {
            request.payload.verified_by = request.params.currentUser._id;
            request.payload.verifiedOn = new Date();
          }
          if (request.payload.old_password) {
            that.log.warn('Updating user password', { request: request, security: true});
            if (user.validPassword(request.payload.old_password)) {
              if (!UserModel.isStrongPassword(request.payload.new_password)) {
                that.log.warn('Could not update user password. New password is not strong enough', { request: request, security: true, fail: true});
                throw Boom.badRequest('Password is not strong enough');
              }
              request.payload.password = UserModel.hashPassword(request.payload.new_password);
              request.payload.lastPasswordReset = new Date();
              request.payload.passwordResetAlert30days = false;
              request.payload.passwordResetAlert7days = false;
              request.payload.passwordResetAlert = false;
              that.log.warn('Successfully updated user password', { request: request, security: true});
              return that._updateQuery(request, options);
            }
            else {
              that.log.warn('Could not update user password. Old password is wrong', { request: request, security: true, fail: true});
              throw Boom.badRequest('The old password is wrong');
            }
          }
          else {
            return that._updateQuery(request, options);
          }
        })
        .then(user => {
          return reply(user);
        })
        .catch(err => {
          that._errorHandler(err, request, reply);
        });
    }
    else {
      if (!request.payload.verified) {
        request.payload.verified_by = null;
        request.payload.verifiedOn = null;
      }
      this._updateQuery(request, options)
        .then(user => {
          return reply(user);
        })
        .catch(err => {
          that._errorHandler(err, request, reply);
        });
    }
  }

  destroy (request, reply) {
    const User = this.app.orm.User;

    if (!request.params.currentUser.is_admin && request.params.currentUser._id.toString() !== request.params.id) {
      return reply(Boom.forbidden('You are not allowed to delete this account'));
    }

    this.log.debug('[UserController] (destroy) model = user, query =', request.query, { request: request });

    const that = this;

    User
      .findOne({ _id: request.params.id })
      .then(user => {
        return user.remove();
      })
      .then(() => {
        return reply().code(204);
      })
      .catch(err => {
        that.app.services.ErrorService.handle(err, request, reply);
      });
  }

  setPrimaryEmail (request, reply) {
    const Model = this.app.orm.user;
    const email = request.payload.email;
    const that = this;

    this.log.debug('[UserController] Setting primary email', { request: request });

    if (!request.payload.email) {
      return reply(Boom.badRequest());
    }

    Model
      .findOne({ _id: request.params.id})
      .then(record => {
        if (!record) {
          throw Boom.notFound();
        }
        // Make sure email is validated
        const index = record.emailIndex(email);
        if (index === -1) {
          throw Boom.badRequest('Email does not exist');
        }
        if (!record.emails[index].validated) {
          throw Boom.badRequest('Email has not been validated. You need to validate it first.');
        }
        record.email = email;
        // If we are there, it means that the email has been validated, so make sure email_verified is set to true.
        record.verifyEmail(email);
        return record.save();
      })
      .then(record => {
        return that.app.services.GSSSyncService.synchronizeUser(record);
      })
      .then(record => {
        return that.app.services.OutlookService.synchronizeUser(record);
      })
      .then(record => {
        return reply(record);
      })
      .catch(err => {
        that._errorHandler(err, request, reply);
      });
  }

  validateEmail (request, reply) {
    const Model = this.app.orm.user;
    let email = '', query = {};

    this.log.debug('[UserController] Verifying email ', { request: request });

    if (!request.payload.hash && !request.params.email) {
      return reply(Boom.badRequest());
    }

    // TODO: make sure current user can do this

    if (request.payload.hash) {
      query = Model.findOne({hash: request.payload.hash, hashAction: 'verify_email'});
    }
    else {
      email = request.params.email;
      query = Model.findOne({'emails.email': email});
    }

    const that = this;
    let grecord = {};
    query
      .then(record => {
        if (!record) {
          throw Boom.notFound();
        }
        if (request.payload.hash) {
          // Verify hash
          if (record.validHash(request.payload.hash) === true) {
            // Verify user email
            if (record.email === record.hashEmail) {
              record.email_verified = true;
              record.expires = new Date(0, 0, 1, 0, 0, 0);
              record.emails[0].validated = true;
              record.emails.set(0, record.emails[0]);
              if (record.isVerifiableEmail(record.hashEmail)) {
                record.verified = true;
                record.verified_by = hidAccount;
                record.verifiedOn = new Date();
              }
              return record.save();
            }
            else {
              for (let i = 0, len = record.emails.length; i < len; i++) {
                if (record.emails[i].email === record.hashEmail) {
                  record.emails[i].validated = true;
                  record.emails.set(i, record.emails[i]);
                }
              }
              if (record.isVerifiableEmail(record.hashEmail)) {
                record.verified = true;
                record.verified_by = hidAccount;
                record.verifiedOn = new Date();
              }
              return record.save();
            }
          }
          else {
            throw Boom.badRequest('Invalid hash');
          }
        }
        else {
          // Send validation email again
          const appValidationUrl = request.payload.app_validation_url;
          if (!that.app.services.HelperService.isAuthorizedUrl(appValidationUrl)) {
            that.log.warn('Invalid app_validation_url', { security: true, fail: true, request: request});
            throw Boom.badRequest('Invalid app_validation_url');
          }
          return that.app.services.EmailService.sendValidationEmail(record, email, appValidationUrl);
        }
      })
      .then(record => {
        grecord = record;
        if (request.payload.hash && record.email === record.hashEmail) {
          return that.app.services.EmailService.sendPostRegister(record);
        }
      })
      .then(info => {
        if (request.payload.hash) {
          return reply(grecord);
        }
        else {
          return reply('Validation email sent successfully').code(202);
        }
      })
      .catch(err => {
        that._errorHandler(err, request, reply);
      });
  }

  // Send a password reset email
  // TODO: make sure we control flood
  sendResetPassword (request, reply) {
    const User = this.app.orm.User;
    const appResetUrl = request.payload.app_reset_url;
    const that = this;

    if (!this.app.services.HelperService.isAuthorizedUrl(appResetUrl)) {
      this.log.warn('Invalid app_reset_url', { security: true, fail: true, request: request});
      return reply(Boom.badRequest('app_reset_url is invalid'));
    }
    User
      .findOne({email: request.payload.email.toLowerCase()})
      .then(record => {
        if (!record) {
          return that._errorHandler(Boom.badRequest('Email could not be found'), request, reply);
        }
        return that.app.services.EmailService.sendResetPassword(record, appResetUrl);
      })
      .then(info => {
        return reply('Password reset email sent successfully').code(202);
      })
      .catch(err => {
        that._errorHandler(err, request, reply);
      });
  }

  updatePassword (request, reply) {
    const User = this.app.orm.user;
    const UserModel = this.app.models.User;

    this.log.debug('[UserController] Updating user password', { request: request });

    if (!request.payload.old_password || !request.payload.new_password) {
      return reply(Boom.badRequest('Request is missing parameters (old or new password)'));
    }

    if (!UserModel.isStrongPassword(request.payload.new_password)) {
      this.log.warn('New password is not strong enough', { request: request, security: true, fail: true});
      return reply(Boom.badRequest('New password is not strong enough'));
    }

    const that = this;
    // Check old password
    User
      .findOne({_id: request.params.id})
      .then((user) => {
        if (!user) {
          return reply(Boom.notFound());
        }
        that.log.warn('Updating user password', { request: request, security: true});
        if (user.validPassword(request.payload.old_password)) {
          user.password = UserModel.hashPassword(request.payload.new_password);
          that.log.warn('Successfully updated user password', { request: request, security: true});
          return user.save();
        }
        else {
          that.log.warn('Could not update user password. Old password is wrong', { request: request, security: true, fail: true});
          return reply(Boom.badRequest('The old password is wrong'));
        }
      })
      .then(() => {
        return reply().code(204);
      })
      .catch(err => {
        that._errorHandler(err, reply);
      });
  }

  resetPassword (request, reply, checkTotp = true) {
    const Model = this.app.orm.User;
    const UserModel = this.app.models.User;
    const that = this;
    const authPolicy = this.app.policies.AuthPolicy;

    if (!request.payload.hash || !request.payload.password) {
      return reply(Boom.badRequest('Wrong arguments'));
    }

    if (!UserModel.isStrongPassword(request.payload.password)) {
      this.log.warn('Could not reset password. New password is not strong enough.', { security: true, fail: true, request: request});
      return reply(Boom.badRequest('New password is not strong enough'));
    }

    this.log.warn('Resetting password', { security: true, request: request});
    Model
      .findOne({hash: request.payload.hash, hashAction: 'reset_password'})
      .then(record => {
        if (!record) {
          that.log.warn('Could not reset password. Hash not found', { security: true, fail: true, request: request});
          throw Boom.badRequest('Reset password link is expired or invalid');
        }
        return record;
      })
      .then(record => {
        if (record.totp && checkTotp) {
          // Check that there is a TOTP token and that it is valid
          const token = request.headers['x-hid-totp'];
          return authPolicy.isTOTPValid(record, token);
        }
        else {
          return record;
        }
      })
      .then(record => {
        if (record.validHash(request.payload.hash) === true) {
          const pwd = UserModel.hashPassword(request.payload.password);
          if (pwd === record.password) {
            throw Boom.badRequest('The new password can not be the same as the old one');
          }
          else {
            record.password = pwd;
            record.verifyEmail(record.email);
            if (record.isVerifiableEmail(record.email)) {
              // Reset verifiedOn date as user was able to reset his password via an email from a trusted domain
              record.verified = true;
              record.verified_by = hidAccount;
              record.verifiedOn = new Date();
            }
            record.expires = new Date(0, 0, 1, 0, 0, 0);
            record.is_orphan = false;
            record.is_ghost = false;
            record.hash = '';
            record.lastPasswordReset = new Date();
            record.passwordResetAlert30days = false;
            record.passwordResetAlert7days = false;
            record.passwordResetAlert = false;
            return record.save();
          }
        }
        else {
          throw Boom.badRequest('Reset password link is expired or invalid');
        }
      })
      .then(() => {
        that.log.warn('Password updated successfully', { security: true, request: request});
        return reply('Password reset successfully');
      })
      .catch(err => {
        that._errorHandler(err, request, reply);
      });
  }

  resetPasswordEndpoint (request, reply) {
    if (request.payload.email) {
      return this.sendResetPassword(request, reply);
    }
    else {
      return this.resetPassword(request, reply);
    }
  }

  claimEmail (request, reply) {
    const Model = this.app.orm.User;
    const appResetUrl = request.payload.app_reset_url;
    const userId = request.params.id;

    if (!this.app.services.HelperService.isAuthorizedUrl(appResetUrl)) {
      this.log.warn('Invalid app_reset_url', { security: true, fail: true, request: request});
      return reply(Boom.badRequest('app_reset_url is invalid'));
    }

    const that = this;
    Model
      .findOne({_id: userId})
      .then(record => {
        if (!record) {
          return reply(Boom.notFound());
        }
        return that.app.services.EmailService.sendClaim(record, appResetUrl);
      })
      .then(info => {
        return reply('Claim email sent successfully').code(202);
      })
      .catch(err => {
        that._errorHandler(err, request, reply);
      });
  }

  updatePicture (request, reply) {
    const Model = this.app.orm.User;
    const userId = request.params.id;
    const that = this;

    this.log.debug('[UserController] Updating picture ', { request: request });

    const data = request.payload;
    if (data.file) {
      const image = sharp(data.file);
      let guser = {}, gmetadata = {};
      Model
        .findOne({_id: userId})
        .then(record => {
          if (!record) {
            throw Boom.notFound();
          }
          guser = record;
          return image.metadata();
        })
        .then(function(metadata) {
          if (metadata.format !== 'jpeg' && metadata.format !== 'png') {
            return reply(Boom.badRequest('Invalid image format. Only jpeg and png are accepted'));
          }
          gmetadata = metadata;
          let path = __dirname + '/../../assets/pictures/' + userId + '.';
          let ext = '';
          ext = metadata.format;
          path = path + ext;
          return image
            .resize(200, 200)
            .toFile(path);
        })
        .then(function (info) {
          guser.picture = process.env.ROOT_URL + '/assets/pictures/' + userId + '.' + gmetadata.format;
          return guser.save();
        })
        .then(record => {
          return reply(record);
        })
        .catch(err => {
          that._errorHandler(err, request, reply);
        });
    }
    else {
      return reply(Boom.badRequest('No file found'));
    }
  }

  addEmail (request, reply) {
    const Model = this.app.orm.User;
    const appValidationUrl = request.payload.app_validation_url;
    const userId = request.params.id;

    this.log.debug('[UserController] adding email', { request: request});
    if (!appValidationUrl || !request.payload.email) {
      return reply(Boom.badRequest());
    }

    if (!this.app.services.HelperService.isAuthorizedUrl(appValidationUrl)) {
      this.log.warn('Invalid app_validation_url', { security: true, fail: true, request: request});
      return reply(Boom.badRequest('Invalid app_validation_url'));
    }

    // Make sure email added is unique
    const that = this;
    let user = {};
    Model
      .findOne({'emails.email': request.payload.email})
      .then(erecord => {
        if (erecord) {
          throw Boom.badRequest('Email is not unique');
        }
        return Model.findOne({_id: userId});
      })
      .then(record => {
        if (!record) {
          throw Boom.notFound();
        }
        const email = request.payload.email;
        if (record.emailIndex(email) !== -1) {
          throw Boom.badRequest('Email already exists');
        }
        user = record;
        // Send confirmation email
        return that.app.services.EmailService.sendValidationEmail(record, email, appValidationUrl);
      })
      .then(info => {
        for (let i = 0; i < user.emails.length; i++) {
          that.app.services.EmailService.sendEmailAlert(user, user.emails[i].email, request.payload.email);
        }
        if (user.emails.length === 0 && user.is_ghost) {
          // Turn ghost into orphan and set main email address
          user.is_ghost = false;
          user.is_orphan = true;
          user.email = request.payload.email;
        }
        const data = { email: request.payload.email, type: request.payload.type, validated: false };
        user.emails.push(data);
        return user.save();
      })
      .then(record => {
        return that.app.services.OutlookService.synchronizeUser(record);
      })
      .then(() => {
        return reply(user);
      })
      .catch(err => {
        that._errorHandler(err, request, reply);
      });
  }

  dropEmail (request, reply) {
    const Model = this.app.orm.User;
    const userId = request.params.id;
    const that = this;

    this.log.debug('[UserController] dropping email', { request: request });
    if (!request.params.email) {
      return reply(Boom.badRequest());
    }

    Model
      .findOne({_id: userId})
      .then(record => {
        if (!record) {
          throw Boom.notFound();
        }
        const email = request.params.email;
        if (email === record.email) {
          throw Boom.badRequest('You can not remove the primary email');
        }
        const index = record.emailIndex(email);
        if (index === -1) {
          throw Boom.badRequest('Email does not exist');
        }
        record.emails.splice(index, 1);
        return record.save();
      })
      .then(record => {
        return that.app.services.OutlookService.synchronizeUser(record);
      })
      .then(record => {
        return reply(record);
      })
      .catch(err => {
        that._errorHandler(err, request, reply);
      });
  }

  addPhone (request, reply) {
    const Model = this.app.orm.User;
    const userId = request.params.id;
    const that = this;

    this.log.debug('[UserController] adding phone number', { request: request });

    Model
      .findOne({_id: userId})
      .then(record => {
        if (!record) {
          throw Boom.notFound();
        }
        const data = { number: request.payload.number, type: request.payload.type };
        record.phone_numbers.push(data);
        return record.save();
      })
      .then(record => {
        return that.app.services.OutlookService.synchronizeUser(record);
      })
      .then(record => {
        return reply(record);
      })
      .catch(err => {
        that._errorHandler(err, request, reply);
      });
  }

  dropPhone (request, reply) {
    const Model = this.app.orm.User;
    const userId = request.params.id;
    const phoneId = request.params.pid;
    const that = this;

    this.log.debug('[UserController] dropping phone number', { request: request });

    Model
      .findOne({_id: userId})
      .then(record => {
        if (!record) {
          throw Boom.notFound();
        }
        let index = -1;
        for (let i = 0, len = record.phone_numbers.length; i < len; i++) {
          if (record.phone_numbers[i]._id === phoneId) {
            index = i;
          }
        }
        if (index === -1) {
          throw Boom.notFound();
        }
        // Do not allow deletion of primary phone number
        if (record.phone_numbers[index].number === record.phone_number) {
          throw Boom.badRequest('Can not remove primary phone number');
        }
        record.phone_numbers.splice(index, 1);
        return record.save();
      })
      .then(record => {
        return that.app.services.OutlookService.synchronizeUser(record);
      })
      .then(record => {
        return reply(record);
      })
      .catch(err => {
        that._errorHandler(err, request, reply);
      });
  }

  setPrimaryPhone (request, reply) {
    const Model = this.app.orm.user;
    const phone = request.payload.phone;
    const that = this;

    this.log.debug('[UserController] Setting primary phone number', { request: request });

    if (!request.payload.phone) {
      return reply(Boom.badRequest());
    }
    Model
      .findOne({ _id: request.params.id})
      .then(record => {
        if (!record) {
          throw Boom.notFound();
        }
        // Make sure phone is part of phone_numbers
        let index = -1;
        for (let i = 0, len = record.phone_numbers.length; i < len; i++) {
          if (record.phone_numbers[i].number === phone) {
            index = i;
          }
        }
        if (index === -1) {
          throw Boom.badRequest('Phone does not exist');
        }
        record.phone_number = record.phone_numbers[index].number;
        record.phone_number_type = record.phone_numbers[index].type;
        return record.save();
      })
      .then(user => {
        return that.app.services.GSSSyncService.synchronizeUser(user);
      })
      .then(user => {
        return that.app.services.OutlookService.synchronizeUser(user);
      })
      .then(user => {
        return reply(user);
      })
      .catch(err => {
        that._errorHandler(err, request, reply);
      });
  }

  setPrimaryOrganization (request, reply) {
    const User = this.app.orm.user;
    if (!request.payload) {
      return reply(Boom.badRequest('Missing listUser id'));
    }
    if (!request.payload._id) {
      return reply(Boom.badRequest('Missing listUser id'));
    }
    const that = this;
    User
      .findOne({_id: request.params.id})
      .then(user => {
        if (!user) {
          throw Boom.notFound();
        }
        const checkin = user.organizations.id(request.payload._id);
        if (!checkin) {
          throw Boom.badRequest('Organization should be part of user organizations');
        }
        user.organization = checkin;
        return user.save();
      })
      .then(user => {
        return that.app.services.GSSSyncService.synchronizeUser(user);
      })
      .then(user => {
        return that.app.services.OutlookService.synchronizeUser(user);
      })
      .then(user => {
        return reply(user);
      })
      .catch (err => {
        that._errorHandler(err, request, reply);
      });

  }

  showAccount (request, reply) {
    this.log.info('calling /account.json for ' + request.params.currentUser.email, { request: request });
    const user = JSON.parse(JSON.stringify(request.params.currentUser));
    if (request.params.currentClient && (request.params.currentClient.id === 'iasc-prod' || request.params.currentClient.id === 'iasc-dev')) {
      user.sub = user.email;
    }
    if (request.params.currentClient && request.params.currentClient.id === 'dart-prod') {
      delete user._id;
    }
    if (request.params.currentClient && request.params.currentClient.id === 'kaya-prod') {
      user.name = user.name.replace(' ', '');
    }
    if (request.params.currentClient &&
      (request.params.currentClient.id === 'rc-shelter-database' ||
        request.params.currentClient.id === 'rc-shelter-db-2-prod' ||
        request.params.currentClient.id === 'deep-prod')) {
      user.active = !user.deleted;
    }
    reply(user);
  }

  notify (request, reply) {
    const Model = this.app.orm.User;

    this.log.debug('[UserController] Notifying user', { request: request });

    const that = this;
    Model
      .findOne({ _id: request.params.id})
      .then(record => {
        if (!record) {
          throw Boom.notFound();
        }

        const notPayload = {
          type: 'contact_needs_update',
          createdBy: request.params.currentUser,
          user: record
        };
        that.app.services.NotificationService.send(notPayload, function (out) {
          return reply(out);
        });
      })
      .catch(err => {
        that._errorHandler(err, request, reply);
      });
  }

  addConnection (request, reply) {
    const User = this.app.orm.User;

    this.log.debug('[UserController] Adding connection', { request: request });

    const that = this;

    User
      .findOne({_id: request.params.id})
      .then(user => {
        if (!user) {
          throw Boom.notFound();
        }

        if (!user.connections) {
          user.connections = [];
        }
        if (user.connectionsIndex(request.params.currentUser._id) !== -1) {
          throw Boom.badRequest('User is already a connection');
        }

        user.connections.push({pending: true, user: request.params.currentUser._id});

        return user.save();
      })
      .then(user => {
        reply(user);

        const notification = {
          type: 'connection_request',
          createdBy: request.params.currentUser,
          user: user
        };
        that.app.services.NotificationService.send(notification, function () {

        });
      })
      .catch(err => {
        that._errorHandler(err, request, reply);
      });
  }

  updateConnection (request, reply) {
    const User = this.app.orm.User;

    this.log.debug('[UserController] Updating connection', { request: request });

    const that = this;
    let guser = {};

    User
      .findOne({_id: request.params.id})
      .then(user => {
        if (!user) {
          return reply(Boom.notFound());
        }
        const connection = user.connections.id(request.params.cid);
        connection.pending = false;
        return user.save();
      })
      .then(user => {
        guser = user;
        const connection = user.connections.id(request.params.cid);
        return User.findOne({_id: connection.user});
      })
      .then(cuser => {
        // Create connection with current user
        const cindex = cuser.connectionsIndex(guser._id);
        if (cindex === -1) {
          cuser.connections.push({pending: false, user: guser._id});
        }
        else {
          cuser.connections[cindex].pending = false;
        }
        return cuser.save();
      })
      .then(cuser => {
        reply(guser);
        // Send notification
        const notification = {
          type: 'connection_approved',
          createdBy: guser,
          user: cuser
        };
        that.app.services.NotificationService.send(notification, function () {

        });
      })
      .catch(err => {
        that._errorHandler(err, request, reply);
      });
  }

  deleteConnection (request, reply) {
    const User = this.app.orm.User;

    this.log.debug('[UserController] Deleting connection', { request: request });

    const that = this;

    User
      .findOne({_id: request.params.id})
      .then(user => {
        if (!user) {
          throw Boom.notFound();
        }
        user.connections.id(request.params.cid).remove();
        return user.save();
      })
      .then(user => {
        reply(user);
      })
      .catch(err => {
        that._errorHandler(err, request, reply);
      });
  }
};
