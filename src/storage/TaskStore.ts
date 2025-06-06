import Fuse from 'fuse.js';
import { flow, makeAutoObservable, runInAction } from 'mobx';
import $api from '../../api/http';
import { Task } from '../models/Task';

export class TaskStore {
  tasks: Task[] = [];
  isLoading: boolean = false;
  error: string | null = null;
  searchQuery: string = '';
  statusFilter: 'all' | 'completed' | 'inProgress' = 'all';
  orderFilter: string = '';

  lastFetched: number | null = null;
  fetchDebounceTimeout: number | null = null;
  
  // Fuse instance for fuzzy search
  private fuse: Fuse<Task> | null = null;

  constructor() {
    makeAutoObservable(this, {
      filteredTasks: true, // Mark computed properties
      completedTasks: true,
      runningTasks: true,
      fetchTasks: flow, // explicitly declare generator-based async action
    });
    
    // Initialize Fuse instance
    this.initializeFuse();
  }
  
  // Initialize or reinitialize the Fuse instance when tasks change
  private initializeFuse() {
    const options = {
      keys: ['title'],
      threshold: 0.5, // Lower threshold means more strict matching
      ignoreLocation: true,
      includeScore: true
    };
    
    this.fuse = new Fuse(this.tasks, options);
  }

  // Fetch all tasks with debouncing and caching
  // get /api/tasks
  fetchTasks = flow(function* (this: TaskStore, force = false) {
    const DEBOUNCE_TIME = 5000;
    // Skip fetch if recently loaded (within last 5 seconds) unless forced
    const now = Date.now();
    if (!force && this.lastFetched && now - this.lastFetched < DEBOUNCE_TIME) {
      return;
    }
    
    // Debounce multiple fetch calls
    if (this.fetchDebounceTimeout) {
      clearTimeout(this.fetchDebounceTimeout);
    }
    
    yield new Promise(resolve => {
      this.fetchDebounceTimeout = setTimeout(resolve, 300);
    });

    if (this.isLoading) return;

    this.isLoading = true;
    this.error = null;

    try {
      const response = yield $api.get('/api/tasks');
      this.tasks = response.data;
      this.lastFetched = Date.now();
      
      // Reinitialize Fuse with the new tasks array
      this.initializeFuse();
    } catch (e) {
      this.error = 'Failed to fetch tasks';
      console.error(e);
    } finally {
      this.isLoading = false;
    }
  });

  // Add a new task
  // post /api/tasks
  addTask = async (title: string, description: string, priority?: number, dueDate?: Date | null) => {
    this.isLoading = true;
    this.error = null;
    
    try {
      const response = await $api.post('/api/tasks', { 
        title, 
        description, 
        priority: priority || 0,
        dueDate: dueDate || undefined,
        completed: false 
      });
      
      runInAction(() => {
        this.tasks.push(response.data);
        this.isLoading = false;
        
        // Reinitialize Fuse with the updated tasks array
        this.initializeFuse();
      });
      
      return response.data;
    } catch (error) {
      runInAction(() => {
        this.error = 'Failed to add task';
        this.isLoading = false;
        console.error(error);
      });
      throw error;
    }
  }

  // Toggle task status
  // patch /api/tasks/:id/status
  toggleTaskStatus = async (id: string) => {
    const task = this.tasks.find(task => task.id === id);
    if (!task) return;
    
    // Optimistic update
    const originalStatus = task.completed;
    const taskIndex = this.tasks.findIndex(t => t.id === id);
    
    // Update UI immediately
    runInAction(() => {
      this.tasks[taskIndex] = {
        ...this.tasks[taskIndex],
        completed: !originalStatus
      };
      this.initializeFuse(); // Update Fuse index after changes
    });
    
    // Then make the API call
    try {
      const response = await $api.patch(`/api/tasks/${id}/status`);
      
      // Update with server data if needed
      runInAction(() => {
        this.tasks[taskIndex] = response.data;
      });
    } catch (error) {
      // Revert on error
      runInAction(() => {
        this.tasks[taskIndex] = {
          ...this.tasks[taskIndex],
          completed: originalStatus
        };
        this.error = 'Failed to update task status';
        console.error(error);
      });
    }
  }

  // Edit task
  // patch /api/tasks/:id
  editTask = async (id: string, title: string, priority: number, createdAt: Date, description?: string, dueDate?: Date | null) => {
    this.isLoading = true;
    this.error = null;
    console.log(id, title, description, priority, createdAt, dueDate);
    try {
      const response = await $api.patch(`/api/tasks/${id}`, { 
        title, 
        description,
        priority,
        createdAt,
        dueDate: dueDate || undefined
      });
      
      runInAction(() => {
        const index = this.tasks.findIndex(t => t.id === id);
        if (index !== -1) {
          this.tasks[index] = response.data;
        }
        this.isLoading = false;
        this.initializeFuse(); // Update Fuse index after changes
      });
    } catch (error) {
      runInAction(() => {
        this.error = 'Failed to edit task';
        this.isLoading = false;
        console.error(error);
      });
    }
  }

  // Delete task
  // delete /api/tasks/:id
  deleteTask = async (id: string) => {
    this.isLoading = true;
    this.error = null;
    
    try {
      await $api.delete(`/api/tasks/${id}`);
      runInAction(() => {
        this.tasks = this.tasks.filter(task => task.id !== id);
        this.isLoading = false;
        this.initializeFuse(); // Update Fuse index after changes
      });
    } catch (error) {
      runInAction(() => {
        this.error = 'Failed to delete task';
        this.isLoading = false;
        console.error(error);
      });
    }
  }

  // Set search query
  setSearchQuery = (query: string) => {
    this.searchQuery = query;
  }

  // Set status filter
  setStatusFilter = (filter: 'all' | 'completed' | 'inProgress') => {
    this.statusFilter = filter;
  }

  // Set priority filter
  setOrderFilter = (priority: string) => {
    this.orderFilter = priority;
  }

  get completedTasks() {
    return this.tasks.filter(task => task.completed);
  }
  
  get runningTasks() {
    return this.tasks.filter(task => !task.completed);
  }

  // Get filtered tasks with fuzzy search
  get filteredTasks() {
    let filtered = this.tasks;
    
    // Apply fuzzy search if query exists and fuse is initialized
    if (this.searchQuery && this.fuse) {
      const results = this.fuse.search(this.searchQuery);
      filtered = results.map(result => result.item);
    }
    
    // Apply status filter
    filtered = filtered.filter(task => {
      if (this.statusFilter === 'all') return true;
      if (this.statusFilter === 'completed') return task.completed;
      if (this.statusFilter === 'inProgress') return !task.completed;
      return true;
    });
    
    // Apply priority filter
    if (this.orderFilter) {
      filtered = filtered.filter(task => 
        task.order?.toString() === this.orderFilter
      );
    }
    
    return filtered;
  }
} 