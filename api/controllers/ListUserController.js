'use strict';

const Controller = require('trails/controller');
const Boom = require('boom');
const _ = require('lodash');
const childAttributes = ['lists', 'organization', 'organizations', 'operations', 'bundles', 'disasters', 'functional_roles', 'offices'];

/**
 * @module ListUserController
 * @description Generated Trails.js Controller.
 */
module.exports = class ListUserController extends Controller{

  checkin (request, reply) {
    const options = this.app.packs.hapi.getOptionsFromQuery(request.query);
    const userId = request.params.id;
    const childAttribute = request.params.childAttribute;
    const payload = request.payload;
    const Model = this.app.orm.user;
    const List = this.app.orm.list;

    this.log.debug('[UserController] (checkin) user ->', childAttribute, ', payload =', payload,
      'options =', options);

    if (childAttributes.indexOf(childAttribute) === -1 || childAttribute === 'organization') {
      return reply(Boom.notFound());
    }

    // Make sure there is a list in the payload
    if (!payload.list) {
      return reply(Boom.badRequest('Missing list attribute'));
    }

    const that = this;

    List
      .findOne({ '_id': payload.list })
      .then((list) => {
        // Check that the list added corresponds to the right attribute
        if (childAttribute !== list.type + 's' && childAttribute !== list.type) {
          throw Boom.badRequest('Wrong list type');
        }

        //Set the proper pending attribute depending on list type
        if (list.joinability === 'public' || list.joinability === 'private' || list.isOwner(request.params.currentUser)) {
          payload.pending = false;
        }
        else {
          payload.pending = true;
        }

        payload.name = list.name;
        payload.acronym = list.acronym;
        payload.visibility = list.visibility;

        that.log.debug('Looking for user with id ' + userId);
        return Model
          .findOne({ '_id': userId })
          .then((record) => {
            if (!record) {
              throw Boom.badRequest('User not found');
            }
            return {list: list, user: record};
          });
      })
      .then((result) => {
        let record = result.user,
          list = result.list;
        if (childAttribute !== 'organization') {
          if (!record[childAttribute]) {
            record[childAttribute] = [];
          }

          // Make sure user is not already checked in this list
          for (var i = 0, len = record[childAttribute].length; i < len; i++) {
            if (record[childAttribute][i].list.equals(list._id) && record[childAttribute][i].deleted === false) {
              throw Boom.badRequest('User is already checked in');
            }
          }
        }
        return result;
      })
      .then((result) => {
        that.log.debug('Setting the listUser to the correct attribute');
        var record = result.user,
          list = result.list;
        if (childAttribute !== 'organization') {
          if (!record[childAttribute]) {
            record[childAttribute] = [];
          }

          record[childAttribute].push(payload);
        }
        else {
          record.organization = payload;
        }
        return {list: result.list, user: record};
      })
      .then((result) => {
        that.log.debug('Saving user');
        var user = result.user;
        return user
          .save()
          .then(() => {
            reply(result.user);
            return result;
          });
      })
      .then((result) => {
        var managers = [];
        result.list.managers.forEach(function (manager) {
          if (manager.toString() !== request.params.currentUser._id.toString()) {
            managers.push(manager);
          }
        });
        // Notify list managers of the checkin
        that.app.services.NotificationService.notifyMultiple(managers, {
          type: 'checkin',
          createdBy: result.user,
          params: { list: result.list }
        });
        return result;
      })
      .then((result) => {
        // Notify user if needed
        if (request.params.currentUser.id !== userId) {
          that.log.debug('Checked in by a different user');
          that.app.services.NotificationService.send({
            type: 'admin_checkin',
            createdBy: request.params.currentUser,
            user: result.user,
            params: { list: result.list }
          }, () => { });
        }
        return result;
      })
      .then((result) => {
        // Notify list owner and managers of the new checkin if needed
        var list = result.list,
          user = result.user;
        if (payload.pending) {
          that.log.debug('Notifying list owners and manager of the new checkin');
          that.app.services.NotificationService.sendMultiple(list.managers, {
            type: 'pending_checkin',
            params: { list: list, user: user }
          }, () => { });
        }
      })
      .catch(err => {
        that.app.services.ErrorService.handle(err, reply);
      });
  }

  update (request, reply) {
    const User = this.app.orm.User;
    const List = this.app.orm.List;
    const NotificationService = this.app.services.NotificationService;
    const childAttribute = request.params.childAttribute;
    const checkInId = request.params.checkInId;


    this.log.debug('[ListUserController] (update) model = list, criteria =', request.query, request.params.checkInId, ', values = ', request.payload);

    // Make sure list specific attributes can not be set through update
    if (request.payload.list) {
      delete request.payload.list;
    }
    if (request.payload.name) {
      delete request.payload.name;
    }
    if (request.payload.acronym) {
      delete request.payload.acronym;
    }
    if (request.payload.visibility) {
      delete request.payload.visibility;
    }

    var that = this;
    User
      .findOne({ _id: request.params.id })
      .then(record => {
        if (!record) {
          throw Boom.notFound();
        }
        var lu = record[childAttribute].id(checkInId);
        _.assign(lu, request.payload);
        return record
          .save()
          .then((user) => {
            reply(user);
            return {user: user, listuser: lu};
          });
      })
      .then(result => {
        return List
          .findOne({_id: result.listuser.list})
          .then(list => {
            return {user: result.user, listuser: result.listuser, list: list};
          });
      })
      .then(result => {
        let lu = result.listuser;
        if (lu.pending === true && request.payload.pending === false) {
          // Send a notification to inform user that his checkin is not pending anymore
          var notification = {type: 'approved_checkin', user: result.user, createdBy: request.params.currentUser, params: { list: result.list}};
          NotificationService.send(notification, () => {});
        }
      })
      .catch(err => { that.app.services.ErrorService.handle(err, reply); });
  }

  checkout (request, reply) {
    const options = this.app.packs.hapi.getOptionsFromQuery(request.query);
    const userId = request.params.id;
    const childAttribute = request.params.childAttribute;
    const checkInId = request.params.checkInId;
    const payload = request.payload;
    const User = this.app.orm.user;
    const FootprintService = this.app.services.FootprintService;
    const List = this.app.orm.List;

    this.log.debug('[UserController] (checkout) user ->', childAttribute, ', payload =', payload,
      'options =', options);

    if (childAttributes.indexOf(childAttribute) === -1) {
      return reply(Boom.notFound());
    }

    var that = this;
    User
      .findOne({ _id: request.params.id })
      .then(record => {
        if (!record) {
          throw Boom.notFound();
        }
        var lu = record[childAttribute].id(checkInId);
        // Set deleted to true
        lu.deleted = true;
        return record
          .save()
          .then((user) => {
            return {user: user, listuser: lu};
          });
      })
      .then((result) => {
        reply(result.user);
        return List
          .findOne({ _id: result.listuser.list })
          .then(list => {
            return {user: result.user, listuser: result.listuser, list: list};
          });
      })
      .then((result) => {
        // Send notification if needed
        if (request.params.currentUser.id !== userId) {
          that.app.services.NotificationService.send({
            type: 'admin_checkout',
            createdBy: request.params.currentUser,
            user: result.user,
            params: { list: result.list }
          }, () => { });
        }
        return result;
      })
      .then((result) => {
        // Notify list managers of the checkin
        that.app.services.NotificationService.notifyMultiple(result.list.managers, {
          type: 'checkout',
          createdBy: result.user,
          params: { list: result.list }
        });
        return result;
      })
      .catch(err => { that.app.services.ErrorService.handle(err, reply); });
  }

};
