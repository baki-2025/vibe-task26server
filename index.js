import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient, ServerApiVersion, ObjectId } from 'mongodb';
import Stripe from 'stripe';
import verifyToken from './middleware/verifyToken.js';
import verifyRoleFactory from './middleware/verifyRole.js';

const app = express();
const port = process.env.PORT || 5002;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:5173').split(',');
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.psactc0.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

async function run() {
  try {
    const db = client.db(process.env.DB_NAME || 'taskDB');
    const usersCollection = db.collection('users');
    const tasksCollection = db.collection('tasks');
    const submissionsCollection = db.collection('submissions');
    const paymentsCollection = db.collection('payments');
    const withdrawalsCollection = db.collection('withdrawals');
    const notificationsCollection = db.collection('notifications');
    const reportsCollection = db.collection('reports');

    const verifyRole = (roles) => verifyRoleFactory(usersCollection, roles);
    const verifyWorker = verifyRole(['worker']);
    const verifyBuyer = verifyRole(['buyer']);
    const verifyAdmin = verifyRole(['admin']);
    const verifyBuyerOrAdmin = verifyRole(['buyer', 'admin']);

    // Helper to push a notification
    const addNotification = async ({ message, toEmail, actionRoute }) => {
      await notificationsCollection.insertOne({
        message,
        toEmail,
        actionRoute,
        time: new Date(),
        read: false,
      });
    };

    // ---------------------------------------------------------------------
    // USERS
    // ---------------------------------------------------------------------

    // Create user on registration (or upsert on Google sign-in)
    app.post('/users', async (req, res) => {
      const user = req.body;
      const existing = await usersCollection.findOne({ email: user.email });
      if (existing) {
        return res.send({ message: 'user already exists', insertedId: null });
      }

      const coin = user.role === 'buyer' ? 50 : 10;
      const newUser = {
        name: user.name,
        email: user.email,
        photoURL: user.photoURL || '',
        role: user.role === 'buyer' ? 'buyer' : 'worker',
        coin,
        created_at: new Date(),
      };

      const result = await usersCollection.insertOne(newUser);
      res.send(result);
    });

    // Get current user's role/profile (used by client to gate routes)
    app.get('/users/:email', verifyToken, async (req, res) => {
      if (req.params.email !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' });
      }
      const user = await usersCollection.findOne({ email: req.params.email });
      res.send(user);
    });

    // Top 6 workers by coin (public, for homepage)
    app.get('/best-workers', async (req, res) => {
      const workers = await usersCollection
        .find({ role: 'worker' })
        .sort({ coin: -1 })
        .limit(6)
        .toArray();
      res.send(workers);
    });

    // Admin: all users
    app.get('/admin/users', verifyToken, verifyAdmin, async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

    // Admin: update role
    app.patch('/admin/users/role/:id', verifyToken, verifyAdmin, async (req, res) => {
      const { role } = req.body;
      if (!['admin', 'buyer', 'worker'].includes(role)) {
        return res.status(400).send({ message: 'invalid role' });
      }
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { role } }
      );
      res.send(result);
    });

    // Admin: remove user
    app.delete('/admin/users/:id', verifyToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    });

    // Admin stats
    app.get('/admin/stats', verifyToken, verifyAdmin, async (req, res) => {
      const totalWorkers = await usersCollection.countDocuments({ role: 'worker' });
      const totalBuyers = await usersCollection.countDocuments({ role: 'buyer' });
      const coinAgg = await usersCollection
        .aggregate([{ $group: { _id: null, total: { $sum: '$coin' } } }])
        .toArray();
      const paymentAgg = await paymentsCollection
        .aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }])
        .toArray();

      res.send({
        totalWorkers,
        totalBuyers,
        totalAvailableCoin: coinAgg[0]?.total || 0,
        totalPayments: paymentAgg[0]?.total || 0,
      });
    });

    // ---------------------------------------------------------------------
    // TASKS
    // ---------------------------------------------------------------------

    // Buyer: add new task
    app.post('/tasks', verifyToken, verifyBuyer, async (req, res) => {
      const task = req.body;
      const totalPayable = Number(task.required_workers) * Number(task.payable_amount);

      const buyer = req.currentUser;
      if (buyer.coin < totalPayable) {
        return res.status(400).send({ message: 'Not available Coin. Purchase Coin' });
      }

      const newTask = {
        task_title: task.task_title,
        task_detail: task.task_detail,
        required_workers: Number(task.required_workers),
        payable_amount: Number(task.payable_amount),
        completion_date: task.completion_date,
        submission_info: task.submission_info,
        task_image_url: task.task_image_url || '',
        buyer_name: buyer.name,
        buyer_email: buyer.email,
        created_at: new Date(),
      };

      const result = await tasksCollection.insertOne(newTask);
      await usersCollection.updateOne(
        { email: buyer.email },
        { $inc: { coin: -totalPayable } }
      );
      res.send(result);
    });

    // Buyer: my tasks (descending by completion_date)
    app.get('/tasks/buyer/:email', verifyToken, async (req, res) => {
      if (req.params.email !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' });
      }
      const tasks = await tasksCollection
        .find({ buyer_email: req.params.email })
        .sort({ completion_date: -1 })
        .toArray();
      res.send(tasks);
    });

    // Buyer: update task
    app.patch('/tasks/:id', verifyToken, verifyBuyer, async (req, res) => {
      const { task_title, task_detail, submission_info } = req.body;
      const result = await tasksCollection.updateOne(
        { _id: new ObjectId(req.params.id), buyer_email: req.decoded.email },
        { $set: { task_title, task_detail, submission_info } }
      );
      res.send(result);
    });

    // Buyer: delete task + refund unused coins
    app.delete('/tasks/:id', verifyToken, verifyBuyer, async (req, res) => {
      const task = await tasksCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!task) return res.status(404).send({ message: 'task not found' });
      if (task.buyer_email !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' });
      }

      const refill = task.required_workers * task.payable_amount;
      await usersCollection.updateOne(
        { email: task.buyer_email },
        { $inc: { coin: refill } }
      );
      const result = await tasksCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    });

    // Worker: task list where required_workers > 0
    app.get('/tasks', async (req, res) => {
      const tasks = await tasksCollection
        .find({ required_workers: { $gt: 0 } })
        .sort({ created_at: -1 })
        .toArray();
      res.send(tasks);
    });

    // Worker: single task details
    app.get('/tasks/:id', verifyToken, async (req, res) => {
      const task = await tasksCollection.findOne({ _id: new ObjectId(req.params.id) });
      res.send(task);
    });

    // Admin: all tasks
    app.get('/admin/tasks', verifyToken, verifyAdmin, async (req, res) => {
      const tasks = await tasksCollection.find().toArray();
      res.send(tasks);
    });

    // Admin: delete any task
    app.delete('/admin/tasks/:id', verifyToken, verifyAdmin, async (req, res) => {
      const result = await tasksCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    });

    // ---------------------------------------------------------------------
    // SUBMISSIONS
    // ---------------------------------------------------------------------

    // Worker: submit a task
    app.post('/submissions', verifyToken, verifyWorker, async (req, res) => {
      const s = req.body;
      const worker = req.currentUser;

      const newSubmission = {
        task_id: s.task_id,
        task_title: s.task_title,
        payable_amount: Number(s.payable_amount),
        worker_email: worker.email,
        worker_name: worker.name,
        buyer_name: s.buyer_name,
        buyer_email: s.buyer_email,
        submission_details: s.submission_details,
        current_date: new Date(),
        status: 'pending',
      };

      const result = await submissionsCollection.insertOne(newSubmission);

      await addNotification({
        message: `${worker.name} submitted work for "${s.task_title}"`,
        toEmail: s.buyer_email,
        actionRoute: '/dashboard/task-to-review',
      });

      res.send(result);
    });

    // Worker: my submissions (paginated)
    app.get('/submissions/worker/:email', verifyToken, async (req, res) => {
      if (req.params.email !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' });
      }
      const page = parseInt(req.query.page) || 0;
      const size = parseInt(req.query.size) || 10;

      const total = await submissionsCollection.countDocuments({ worker_email: req.params.email });
      const submissions = await submissionsCollection
        .find({ worker_email: req.params.email })
        .sort({ current_date: -1 })
        .skip(page * size)
        .limit(size)
        .toArray();

      res.send({ submissions, total });
    });

    // Worker: approved submissions only (for worker home stats page)
    app.get('/submissions/approved/:email', verifyToken, async (req, res) => {
      if (req.params.email !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' });
      }
      const submissions = await submissionsCollection
        .find({ worker_email: req.params.email, status: 'approved' })
        .toArray();
      res.send(submissions);
    });

    // Worker home stats
    app.get('/worker/stats/:email', verifyToken, async (req, res) => {
      if (req.params.email !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' });
      }
      const email = req.params.email;
      const totalSubmissions = await submissionsCollection.countDocuments({ worker_email: email });
      const totalPending = await submissionsCollection.countDocuments({ worker_email: email, status: 'pending' });
      const earningAgg = await submissionsCollection
        .aggregate([
          { $match: { worker_email: email, status: 'approved' } },
          { $group: { _id: null, total: { $sum: '$payable_amount' } } },
        ])
        .toArray();

      res.send({
        totalSubmissions,
        totalPending,
        totalEarning: earningAgg[0]?.total || 0,
      });
    });

    // Buyer: pending submissions to review
    app.get('/submissions/buyer/:email', verifyToken, async (req, res) => {
      if (req.params.email !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' });
      }
      const submissions = await submissionsCollection
        .find({ buyer_email: req.params.email, status: 'pending' })
        .toArray();
      res.send(submissions);
    });

    // Buyer home stats
    app.get('/buyer/stats/:email', verifyToken, async (req, res) => {
      if (req.params.email !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' });
      }
      const email = req.params.email;
      const tasks = await tasksCollection.find({ buyer_email: email }).toArray();
      const taskCount = tasks.length;
      const pendingTask = tasks.reduce((sum, t) => sum + (t.required_workers || 0), 0);
      const paymentAgg = await paymentsCollection
        .aggregate([
          { $match: { buyer_email: email } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ])
        .toArray();

      res.send({
        taskCount,
        pendingTask,
        totalPayment: paymentAgg[0]?.total || 0,
      });
    });

    // Buyer: approve submission
    app.patch('/submissions/approve/:id', verifyToken, verifyBuyer, async (req, res) => {
      const submission = await submissionsCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!submission) return res.status(404).send({ message: 'not found' });
      if (submission.buyer_email !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' });
      }

      await submissionsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status: 'approved' } }
      );
      await usersCollection.updateOne(
        { email: submission.worker_email },
        { $inc: { coin: submission.payable_amount } }
      );
      await addNotification({
        message: `You have earned ${submission.payable_amount} coins from ${submission.buyer_name} for completing "${submission.task_title}"`,
        toEmail: submission.worker_email,
        actionRoute: '/dashboard/worker-home',
      });

      res.send({ message: 'approved' });
    });

    // Buyer: reject submission
    app.patch('/submissions/reject/:id', verifyToken, verifyBuyer, async (req, res) => {
      const submission = await submissionsCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!submission) return res.status(404).send({ message: 'not found' });
      if (submission.buyer_email !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' });
      }

      await submissionsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status: 'rejected' } }
      );
      await tasksCollection.updateOne(
        { _id: new ObjectId(submission.task_id) },
        { $inc: { required_workers: 1 } }
      );
      await addNotification({
        message: `Your submission for "${submission.task_title}" was rejected by ${submission.buyer_name}`,
        toEmail: submission.worker_email,
        actionRoute: '/dashboard/my-submissions',
      });

      res.send({ message: 'rejected' });
    });

    // ---------------------------------------------------------------------
    // REPORTS (invalid submissions)
    // ---------------------------------------------------------------------

    app.post('/reports', verifyToken, verifyBuyer, async (req, res) => {
      const report = {
        ...req.body,
        reported_by: req.decoded.email,
        status: 'pending',
        created_at: new Date(),
      };
      const result = await reportsCollection.insertOne(report);
      res.send(result);
    });

    app.get('/admin/reports', verifyToken, verifyAdmin, async (req, res) => {
      const reports = await reportsCollection.find().sort({ created_at: -1 }).toArray();
      res.send(reports);
    });

    app.patch('/admin/reports/:id', verifyToken, verifyAdmin, async (req, res) => {
      const { status } = req.body;
      const result = await reportsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status } }
      );
      res.send(result);
    });

    // ---------------------------------------------------------------------
    // PAYMENTS (Stripe - coin purchase)
    // ---------------------------------------------------------------------

    // Create a payment intent for the selected coin package
    app.post('/create-payment-intent', verifyToken, verifyBuyer, async (req, res) => {
      const { amount } = req.body; // amount in USD dollars
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // cents
        currency: 'usd',
        payment_method_types: ['card'],
      });
      res.send({ clientSecret: paymentIntent.client_secret });
    });

    // Record a successful payment & top up coins
    app.post('/payments', verifyToken, verifyBuyer, async (req, res) => {
      const payment = req.body; // { amount, coins, transactionId }
      const buyer = req.currentUser;

      const paymentRecord = {
        buyer_email: buyer.email,
        buyer_name: buyer.name,
        amount: Number(payment.amount),
        coins: Number(payment.coins),
        transactionId: payment.transactionId,
        date: new Date(),
      };

      const result = await paymentsCollection.insertOne(paymentRecord);
      await usersCollection.updateOne(
        { email: buyer.email },
        { $inc: { coin: Number(payment.coins) } }
      );
      res.send(result);
    });

    // Buyer: payment history
    app.get('/payments/:email', verifyToken, async (req, res) => {
      if (req.params.email !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' });
      }
      const payments = await paymentsCollection
        .find({ buyer_email: req.params.email })
        .sort({ date: -1 })
        .toArray();
      res.send(payments);
    });

    // ---------------------------------------------------------------------
    // WITHDRAWALS
    // ---------------------------------------------------------------------

    // Worker: request withdrawal
    app.post('/withdrawals', verifyToken, verifyWorker, async (req, res) => {
      const w = req.body;
      const worker = req.currentUser;

      if (worker.coin < 200) {
        return res.status(400).send({ message: 'Minimum 200 coins required to withdraw' });
      }
      if (Number(w.withdrawal_coin) > worker.coin) {
        return res.status(400).send({ message: 'Insufficient coin' });
      }

      const withdrawal = {
        worker_email: worker.email,
        worker_name: worker.name,
        withdrawal_coin: Number(w.withdrawal_coin),
        withdrawal_amount: Number(w.withdrawal_amount),
        payment_system: w.payment_system,
        account_number: w.account_number,
        withdraw_date: new Date(),
        status: 'pending',
      };

      const result = await withdrawalsCollection.insertOne(withdrawal);
      res.send(result);
    });

    // Worker: my withdrawals
    app.get('/withdrawals/worker/:email', verifyToken, async (req, res) => {
      if (req.params.email !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' });
      }
      const withdrawals = await withdrawalsCollection
        .find({ worker_email: req.params.email })
        .sort({ withdraw_date: -1 })
        .toArray();
      res.send(withdrawals);
    });

    // Admin: pending withdrawal requests
    app.get('/admin/withdrawals', verifyToken, verifyAdmin, async (req, res) => {
      const withdrawals = await withdrawalsCollection
        .find({ status: 'pending' })
        .sort({ withdraw_date: -1 })
        .toArray();
      res.send(withdrawals);
    });

    // Admin: approve withdrawal (payment success)
    app.patch('/admin/withdrawals/:id', verifyToken, verifyAdmin, async (req, res) => {
      const withdrawal = await withdrawalsCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!withdrawal) return res.status(404).send({ message: 'not found' });

      await withdrawalsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status: 'approved' } }
      );
      await usersCollection.updateOne(
        { email: withdrawal.worker_email },
        { $inc: { coin: -withdrawal.withdrawal_coin } }
      );
      await addNotification({
        message: `Your withdrawal of $${withdrawal.withdrawal_amount} has been approved`,
        toEmail: withdrawal.worker_email,
        actionRoute: '/dashboard/withdrawals',
      });

      res.send({ message: 'approved' });
    });

    // ---------------------------------------------------------------------
    // NOTIFICATIONS
    // ---------------------------------------------------------------------

    app.get('/notifications/:email', verifyToken, async (req, res) => {
      if (req.params.email !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' });
      }
      const notifications = await notificationsCollection
        .find({ toEmail: req.params.email })
        .sort({ time: -1 })
        .limit(30)
        .toArray();
      res.send(notifications);
    });

    // ---------------------------------------------------------------------

    await client.db('admin').command({ ping: 1 });
    console.log('✅ Connected to MongoDB');
  } finally {
    // client stays open for the life of the server
  }
}
run().catch(console.error);

app.get('/', (req, res) => {
  res.send('Micro Tasking and Earning Platform server is running');
});

app.listen(port, () => {
  console.log(`🚀 Server listening on port ${port}`);
});
